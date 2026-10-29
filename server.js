/* Hero's Journey — a small local server that wires the mockup to Comfy Cloud.
 *
 * Zero dependencies, Node 22+ (global fetch / FormData / Blob).
 *   node server.js            then open http://127.0.0.1:8800
 *
 * The key lives in .env (gitignored) as COMFY_API_KEY=... or in the
 * environment. It never reaches the browser: the page can ask whether there
 * is one and can hand a new one over, and that is all.
 *
 * Endpoints
 *   POST /api/key             { key } -> checks it against Comfy, writes .env
 *   POST /api/upload?name=    raw bytes -> Comfy input/, returns { name }
 *   POST /api/run             { rung, values } -> { jobId }
 *   GET  /api/job/<id>        -> { state, done, ok, error, outputs[] }
 *   GET  /api/file?filename=  streams a finished output back through us, so
 *                             the signed URL and the key both stay server-side
 */

import { createServer } from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { exec } from "node:child_process";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT || 8800);
/* LOOPBACK UNLESS SOMEBODY ASKS OTHERWISE. This binds to 127.0.0.1 because
 * the thing it is is a local app holding your own API key, and a server that
 * answers the network by default is one nobody decided should. `HOST=0.0.0.0`
 * is the decision, for putting it behind a proxy or in a container.
 * THE KEY PANEL DOES NOT COME WITH IT, and that is deliberate: `/api/key`
 * refuses anything that is not loopback whatever this is set to, so a hosted
 * instance takes its key from `COMFY_API_KEY` in the environment - which
 * `loadKey` already prefers - and the one endpoint that writes a credential
 * stays unreachable from outside. */
const HOST = process.env.HOST || "127.0.0.1";

/* ONE INSTANCE, MANY STRANGERS - AND THIS APP OPENS ON WHAT IT FINDS.
 * `fill()` dresses every empty slot from output/ at boot, which is right on
 * the machine that made those files and is the one thing that would break
 * the premise of the app on a shared one: the second visitor would arrive to
 * find the first visitor's character already standing in the slots. Babe,
 * 2026-10-28, on the hosted demo: "should be empty hero's journey session /
 * brand new".
 *
 * THE MECHANISM ALREADY EXISTS AND IT IS A SITTING. Everything that dresses
 * the rail - fill, dress, S, newestIn - already filters on the session in
 * the path, and the browser's drawer is keyed by session name, so a visitor
 * with a sitting of their own opens on an empty rail by the rule the rail
 * already runs on. All this adds is WHO the visitor is: a cookie, minted
 * where the page already asks which sitting it is in, and read by the three
 * places that write a file and the two that serve one.
 *
 * SO `DEMO=1` IS A SWITCH AND NOT A FORK. The repo people clone is this
 * code; the hosted thing is this code with the flag set. */
const DEMO = process.env.DEMO === "1";

/* AND NOBODY'S KEY IS BAKED INTO IT. Babe, 2026-10-28: "empty the api key
 * out, the users testing it will use their own key to unlock". The release
 * already says you need one, so this is not a second design: it is the SAME
 * design, which is the key panel being the only way in. The only difference
 * is where the key is kept - a file on the machine you installed it on, and
 * nothing but memory on a shared one, because a stranger's credential is not
 * ours to write down and the next visitor must never inherit it.
 *
 * SO A DEMO IS NOT METERED AND DOES NOT NEED TO BE. A visitor spends their
 * own credits, and with no key nothing under /api/ that reaches Comfy
 * answers at all - so there is nothing of Babe's left to bound. The run
 * budget this was planned with was an answer to a bill that no longer
 * exists, and a cap that protects nothing is a mechanism to delete. */
const BASE = "https://cloud.comfy.org";

/* EVERY FINISHED FILE IS KEPT, filed by day and by the rung that made it:
 *
 *   output/2026-10-24/01-become-someone/143052-nano-banana-21-1478421373.png
 *
 * Comfy names files by content hash, which is unfindable an hour later, so
 * the name carries the time, the model and the seed instead — enough to tell
 * two rerolls apart and to reproduce either. Writes are skipped if the file
 * is already there, so polling a finished job does not refetch it. */
const OUT = join(HERE, "output");

const JOBS = new Map();   // jobId -> what made it, for naming the file
/* AND HOW MANY POLLS IN A ROW A JOB WE SUBMITTED MAY FAIL BEFORE WE BELIEVE
 * IT. The page polls every two seconds, so five is about ten seconds of Comfy
 * being unable to answer - far longer than registration has ever taken, and
 * short enough that a job it has really lost says so rather than being polled
 * for ever. It is a count rather than an age because a hiccup two minutes
 * into a clip is the same hiccup. */
const JOB_MISSES = 5;

const slug = (x) =>
  String(x).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return {
    day: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`,
  };
}

/* OUTPUT IS SESSIONS AND SECTIONS, AND NOTHING ELSE - Babe, 2026-10-25:
 * "can we fix the folder name / structure", "maybe just do
 * output/session01/01/", "so its simple".
 * IT WAS NAMED FROM THE SERVER'S `label`, WHICH IS NOT WHAT THE RAIL CALLS
 * ANYTHING. That label is written for an error - "Your own shot needs ref1"
 * reads fine in a sentence - and a folder is not a sentence, it is a thing
 * you browse. So 04 had TWO folders, `04-the-board` and
 * `04-put-them-in-motion`, for one rung that makes two things; 05 was filed
 * as `05-your-own-shot` when the section is called KEEP MOVING; and a roll
 * landed in `random-random-character`, which says it twice.
 * THE NUMBER IS ENOUGH. It is what the nav shows, what the tick shows and
 * what the review panel shows, and it cannot drift from a string somewhere
 * else because it is not a string. The board and the clip share 04 the way
 * they share the rung, and the filename already tells them apart - different
 * model, different extension.
 * A SESSION IS A DAY OF WORK, numbered in the order they happened. The day
 * itself was the old top level and it is the wrong unit: it reads as an
 * archive rather than as a piece of work, and "session01" is what a person
 * calls the first time they sat down with this. The mapping lives in a
 * marker inside each folder rather than in an index, so a session cannot be
 * orphaned from its own name and a restart cannot renumber anything. */
const DAY_MARK = ".day";
/* A SESSION IS A SITTING, NOT A DATE - Babe, 2026-10-26: "can we create a new
 * session state so i can go through each one with a new character. so remove
 * the other character. i want to keep that other session state as well tho",
 * and the reason under it: "i need to start recording videos".
 * THE DAY WAS A GOOD PROXY UNTIL TWO SITTINGS SHARED ONE. A day marker still
 * names a folder and still keeps a restart from renumbering anything - but
 * WHICH session is the current one is a thing somebody decides now, so it is
 * written down rather than derived. `.current` holds that name; with no
 * `.current` the day rule answers exactly as it did before. */
const CURRENT = ".current";

function sessionNames() {
  try {
    return readdirSync(OUT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^session\d+$/.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch { return []; }
}

function sessionDay(name) {
  try { return readFileSync(join(OUT, name, DAY_MARK), "utf8").trim(); }
  catch { return ""; }
}

function currentSession() {
  try {
    const name = readFileSync(join(OUT, CURRENT), "utf8").trim();
    if (/^session\d+$/.test(name) && existsSync(join(OUT, name))) return name;
  } catch { /* none yet, or unreadable - the day rule answers */ }
  return "";
}

/* THE ONLY WAY A SESSION IS EVER MADE, so the numbering and the two markers
 * cannot be written in two places and disagree. */
/* AND THE FOLDER IS WHAT CLAIMS THE NUMBER, NOT THE SCAN. One person at one
 * keyboard cannot race themselves, so reading the highest number and adding
 * one was enough for as long as that was the only way in. Two visitors
 * landing on a hosted instance in the same second both read the same highest
 * number, and then they are in one another's sitting - which is the single
 * thing per-visitor sessions exist to prevent. `mkdirSync` without
 * `recursive` throws EEXIST, so the directory is the lock: whoever creates
 * it owns the name and the other one tries the next.
 * AND `.current` IS NOT WRITTEN ON A SHARED INSTANCE. It means "the sitting
 * this machine is in", which is a fact about one person at one keyboard; on
 * a demo the visitor's cookie says which sitting is theirs and a global
 * marker could only be the last stranger to arrive. */
function makeSession(day) {
  let n = sessionNames().reduce((m, x) => Math.max(m, +x.slice(7) || 0), 0) + 1;
  for (;;) {
    const name = `session${String(n).padStart(2, "0")}`;
    try {
      mkdirSync(join(OUT, name));
    } catch (err) {
      if (err.code === "EEXIST") { n++; continue; }
      if (err.code === "ENOENT") { mkdirSync(OUT, { recursive: true }); continue; }
      throw err;
    }
    writeFileSync(join(OUT, name, DAY_MARK), day + "\n");
    if (!DEMO) writeFileSync(join(OUT, CURRENT), name + "\n");
    return name;
  }
}

function sessionDir(day) {
  const current = currentSession();
  if (current) return current;
  let names = [];
  try {
    names = readdirSync(OUT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^session\d+$/.test(e.name))
      .map((e) => e.name);
  } catch { /* no output/ yet */ }

  for (const name of names) {
    try {
      if (readFileSync(join(OUT, name, DAY_MARK), "utf8").trim() === day) return name;
    } catch { /* a session with no marker is not this one */ }
  }
  try { return makeSession(day); }
  catch { return `session${String(names.length + 1).padStart(2, "0")}`; }
}

/* ------------------------------------------------------- who is visiting
 * ONLY ON A DEMO, AND THE COOKIE IS THE SESSION NAME ITSELF. A table mapping
 * visitors to sittings would be a second record of the same fact, free to
 * disagree with the folders on disk; the name already passes the one test
 * anything here makes of it. So there is nothing to keep in step: the cookie
 * is either a session that exists or it is nobody. */
const VISITOR = "hj";
const DEMO_DAYS = 30;

function cookieOf(req, name) {
  for (const bit of String(req.headers.cookie || "").split(";")) {
    const i = bit.indexOf("=");
    if (i > 0 && bit.slice(0, i).trim() === name) return bit.slice(i + 1).trim();
  }
  return "";
}

function visitorSession(req) {
  if (!DEMO) return "";
  const want = cookieOf(req, VISITOR);
  return /^session\d+$/.test(want) && existsSync(join(OUT, want)) ? want : "";
}

/* A SITTING OF THEIR OWN, HANDED OVER IN THE SAME BREATH AS THE PAGE ASKING
 * WHICH ONE IT IS IN. `Secure` is conditional because the demo is behind
 * https and every test of it is not, and a cookie a browser refuses is a
 * visitor who shares the next one's rail. */
function mintVisitor(req, res) {
  const name = makeSession(stamp().day);
  const https = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
  res.setHeader("Set-Cookie", `${VISITOR}=${name}; Path=/; Max-Age=${DEMO_DAYS * 86400}` +
    `; SameSite=Lax${https ? "; Secure" : ""}`);
  console.log(`  <- a visitor arrives: ${name}`);
  return name;
}

/* WHOSE FILE IS THIS. Nobody is handed a path they did not make - the
 * listing is already scoped - so this is about a path somebody typed. The
 * thumbnails are shared because a thumbnail is of a file this already
 * answered for. */
function maySee(req, rel) {
  if (!DEMO) return true;
  const slashed = String(rel).replace(/\\/g, "/").replace(/^\/+/, "");
  if (!slashed.startsWith("output/")) return true;
  const who = visitorSession(req);
  const whose = slashed.split("/")[1] || "";
  return whose === ".thumbs" || (!!who && whose === who);
}

async function keep(id, file) {
  const made = JOBS.get(id);
  if (!made) return null;
  const { day, time } = stamp();
  /* THE SITTING IS THE ONE THAT PRESSED RUN, not the one that is current
   * when the file lands. A poll has no visitor on it - it is a request about
   * a job id - so the session rides on the record of what made this, beside
   * the model and the seed, which is where every other fact about this file
   * that the path cannot carry already lives. */
  const session = made.session || sessionDir(day);
  const dir = join(OUT, session, made.rungName);
  const ext = (file.filename.match(/\.[a-z0-9]+$/i) || [".png"])[0];
  const name = [time, made.modelSlug, made.seed].filter(Boolean).join("-") + ext;
  const full = join(dir, name);
  const rel = `output/${session}/${made.rungName}/${name}`;
  if (existsSync(full)) return rel;
  try {
    const q = new URLSearchParams({
      filename: file.filename, subfolder: file.subfolder || "", type: file.type || "output",
    });
    const look = await fetch(`${BASE}/api/view?${q}`, { headers: headers(), redirect: "manual" });
    const loc = look.headers.get("Location");
    const hit = loc ? await fetch(loc) : look;
    if (!hit.ok) return null;
    await mkdir(dir, { recursive: true });
    await writeFile(full, Buffer.from(await hit.arrayBuffer()));
    /* A CHARACTER'S FACTS ARE KEPT WITH THE PICTURE THEY DESCRIBE. The traits
     * were composed, read into 02's prompt and thrown away - the one thing
     * this app made and did not keep, while every file it made was already on
     * disk. The sidecar takes the file's own name, which is a time, a model
     * and a seed and is already unique, so a move cannot separate the two.
     * A sidecar that will not write is not worth failing a finished
     * generation over. */
    if (made.bible) {
      const side = full.replace(/\.[a-z0-9]+$/i, "") + ".json";
      try {
        await writeFile(side, JSON.stringify(
          { v: 1, ...made.bible, model: made.modelSlug, seed: made.seed, day }, null, 2));
      } catch (err) { console.error("could not keep the traits for", rel, err.message); }
    }
    return rel;
  } catch (err) {
    console.error("could not keep", rel, err.message);
    return null;
  }
}

/* ---------------------------------------------------------------- the key */

function loadKey() {
  if (process.env.COMFY_API_KEY) return process.env.COMFY_API_KEY.trim();
  const envFile = join(HERE, ".env");
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*COMFY_API_KEY\s*=\s*(.*)$/);
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  return "";
}
/* `let`, BECAUSE THE KEY CAN ARRIVE AFTER BOOT. The button in the bar writes
 * .env and sets this, so a key pasted at 12:01 works at 12:01 - a saved key
 * that needed a restart would be a worse version of editing the file by hand,
 * which is the only reason the button exists. Everything that authenticates
 * reads KEY at call time, so there is nothing else to tell. */
let KEY = loadKey();

/* An OAuth bearer and a comfyui- key authenticate differently, and a partner
 * node inside a graph authenticates from INSIDE the payload rather than from
 * the header — which is why extra_data is sent on every submit. */
const headersFor = (key, extra) => ({
  ...(key.startsWith("comfyui-") ? { "X-API-Key": key } : { Authorization: `Bearer ${key}` }),
  ...extra,
});
/* ONE PLACE DECIDES THE HEADER SHAPE. The key panel has to authenticate a key
 * that is not KEY yet - it is checking whether to keep it - and a second copy
 * of this branch is a second thing that can be wrong about what a comfyui-
 * key is. */
/* AND ON A SHARED INSTANCE THE KEY BELONGS TO THE REQUEST, NOT TO THE
 * PROCESS. Every call to Comfy in this file goes through `headers()` or
 * `extraData()` - the submit, the poll, the two uploads, the view, the carry,
 * and whatever is added next month - so the honest way to hand nine call
 * sites a different key is to not tell them about it. `AsyncLocalStorage` is
 * in node and costs nothing: the request handler runs inside a store holding
 * that visitor's key, the two readers below prefer it, and a site added later
 * is right without knowing any of this exists. THREADING IT AS AN ARGUMENT
 * WOULD BE NINE SIGNATURES AND ONE OF THEM FORGOTTEN - and the one forgotten
 * is a visitor's job quietly submitted on somebody else's credits. */
const ASKING = new AsyncLocalStorage();
/* `undefined` IS THE ONLY THING THAT FALLS BACK, and an empty string must
 * not: on a demo the store is always set, to the visitor's key or to nothing,
 * and `||` would have handed somebody who has pasted no key the process's own
 * - which on a hosted instance is the one thing that must never happen. */
const keyNow = () => { const s = ASKING.getStore(); return s === undefined ? KEY : s; };
const headers = (extra) => headersFor(keyNow(), extra);
const extraData = () => {
  const k = keyNow();
  return k.startsWith("comfyui-") ? { api_key_comfy_org: k } : { auth_token_comfy_org: k };
};

/* WHOSE KEY IS WHOSE, AND IT IS NEVER WRITTEN DOWN. A demo visitor pastes
 * their own into the same panel the installed app uses; what differs is that
 * this one keeps it in memory, under the cookie that already says which
 * sitting is theirs, and the process forgets every one of them when it
 * stops. A restart costs a paste, which is the right price for not holding
 * somebody else's credential on a disk.
 * AND IT LAPSES. A key left here by somebody who closed the tab a day ago is
 * a key we are keeping for nobody, so an unused one is dropped. */
const DEMO_KEYS = new Map();
const DEMO_KEY_TTL = 12 * 60 * 60 * 1000;

function demoKey(req) {
  const who = visitorSession(req);
  const held = who && DEMO_KEYS.get(who);
  if (!held) return "";
  if (Date.now() - held.at > DEMO_KEY_TTL) { DEMO_KEYS.delete(who); return ""; }
  held.at = Date.now();
  return held.key;
}

/* ------------------------------------------------------------ the three rungs
 *
 * Each input names the node and input it patches. `also` is a second address
 * that must carry the same value — SCAIL-2 runs two chunks and each has its
 * own copy of the prompt, the subject and the seed, so writing one and not
 * the other gives you two different takes welded together.
 */
/* ----------------------------------------------------------------- the edit
 *
 * 01 HAS TWO MODES AND THEY ARE OPPOSITE JOBS. STYLE turns the person in
 * image 1 into the character in image 2 - an edit so large that the only
 * thing asked to survive is the face. EDIT changes one named thing and is
 * judged on everything it left alone. The two cannot share a sentence, and
 * the mode is what picks between them.
 *
 * THE TAB WAS LANDING ON THE STYLE JOB. `modes` is the whole fix: before
 * this, pressing EDIT sent `mode: "EDIT"` to a rung with no entry for it, so
 * the server composed the become-someone instruction, 475 dropped because
 * nobody had filled it, and the run came back looking like it had worked.
 * That is the failure this file keeps paying for, one rung further along.
 *
 * AND A PRESERVATION-HEAVY PROMPT UNDER-EDITS, which 01 already paid for from
 * the other side: leading with "keep image 1 exactly" made the model do the
 * keeping and skip the costume. So this leads with the operation and states
 * what carries afterwards. On an edit both failures are real, which is why
 * the artist's own line is the only thing allowed to name what moves.
 *
 * NO BEFORE-AND-AFTER. Handed one picture and an instruction, an image model
 * will cheerfully return the pair side by side - the same grid failure
 * PLACE_SYS exists to forbid, arriving by a different route. */
/* AND THE TWO REFERENCES ARE NAMED BY THE CALLER, because the addressing
 * convention is per model and always has been: nano and qwen read "Image 1"
 * and "Image 2", FLUX 3 Klein reads `<ref_image_0>` and `<ref_image_1>`, and
 * a sentence written for one of them does not reach the other. The default is
 * what every row here said before the Klein row arrived, so nothing that was
 * already working had to be touched to add one that reads differently. */
const EDIT_SYS = (hasRef, one, two) =>
  (one = one || "image 1", two = two || "image 2",
  "You are editing one photograph. " + cap(one) + " is that photograph. "
  + "Make the change the instruction asks for and make no other change: "
  + "everything it does not name stays exactly as it is - the same person "
  + "with the same face, the same framing, camera angle and distance, the "
  + "same pose and expression, the same wardrobe, the same light and the "
  + "same background. "
  + (hasRef
      ? cap(two) + " is only the thing the instruction refers to: take from "
        + "it what the instruction names and nothing else, never its face, "
        + "its framing, its light or its background. "
      : "")
  + "Return ONE photograph of the edited " + one + ": a single frame, edge to "
  + "edge, with no panels, no grid, no before-and-after, no split screen, "
  + "no inset and no border. "
  + "Photographic, in focus, no text and no watermark.");

/* AND THE SAME SENTENCE IN THE ENCODER'S REGISTER - Babe, 2026-10-27,
 * looking at an EDIT that came back as the photograph it was given: "yeah
 * edit is doing nothing".
 * THE REGISTER IS PER MODEL, NOT PER JOB, which is the lesson `STYLE_SYS`
 * was cut by the same day and this one was left behind by. Nano reads the
 * long version in its own `system_prompt` input and follows instructions;
 * qwen and FLUX have no such input, so the server joins the scaffolding to
 * the FRONT of the artist's line and the whole thing is encoded at cfg 1,
 * where there is no classifier-free guidance and conditioning is the only
 * steering there is. A hundred words of what to keep against six words of
 * what to change is a job whose correct answer is the picture you started
 * with - which is exactly what came back.
 * SO IT LEADS WITH THE OPERATION AND KEEPS ONE PRESERVATION CLAUSE, and it
 * ends on a colon so the line the artist wrote is the instruction rather
 * than a second sentence. Mage-Flow's own template note says the same thing
 * from the other side: state what to keep, then what to change.
 * (*) Both strings are mine. */
const EDIT_LINE = (hasRef, one, two) =>
  (one = one || "image 1", two = two || "image 2",
  hasRef
    ? "Edit " + one + " as instructed, taking only the named thing from "
      + two + ". Change nothing else:"
    : "Edit " + one + " as instructed. Change nothing else:");

/* a reference name starts a sentence as often as it sits inside one, and
 * `<ref_image_0>` must not be capitalised into something the model does not
 * read. Only a plain word is lifted. */
function cap(name) {
  return /^[a-z]/.test(name) ? name[0].toUpperCase() + name.slice(1) : name;
}

/* ---------------------------------------------------------------- the sheet
 *
 * ONE CALL, ONE REFERENCE, NOT FOUR CALLS STITCHED. Four separate jobs drift
 * four separate faces, which is the exact inconsistency the sheet exists to
 * remove — and the stitch would then have to be built and paid for as well.
 * The view count is prompt-shaping rather than a node input, so rung 02's
 * `sys` is a function of the values instead of a string.
 */
/* WHICH PANELS is the artist's choice and arrives with the prompt; the page
 * holds that table beside the previews it draws from it. What is left here is
 * what belongs to the model whatever layout it is given.
 *
 * THE GROUND IS BLACK, NOT DARK. The sheet gets composited in `screen`, which
 * only drops true black - a dark grey ground lifts the whole plate - so this
 * asks for black by name rather than for "a dark background".
 *
 * NO TEXT ON THE IMAGE. The template it is given as a reference has grid lines
 * and a label in every panel, and a model handed a labelled guide will happily
 * letter the result to match. The labels are an instruction, not content, and
 * the character's own facts live in the traits JSON instead. */
/* SEAMLESS BETWEEN PANELS, BLACK ALL THE WAY AROUND. The template draws a
 * gutter so its divisions read as divisions, and the lines say WHERE a panel
 * ends rather than that a line belongs there - from Babe's contact-sheet
 * system prompt, along with "contact sheet" as a phrase worth saying out
 * loud, since the models know the form by name.
 *
 * WHAT THE FIRST REAL SHEETS SETTLED, 2026-10-24. The panels came back flush
 * with no gaps, on their own solid grounds, inside a black border - and that
 * is the sheet Babe wants: "as a sheet it makes sense they are on solid
 * backgrounds", "the 3x3 does not have gaps tho", "the black around the
 * frames / the border is all i care about staying black".
 *
 * So two rules changed. The ground inside a panel is no longer required to be
 * pure black, only flat and the same in every panel - a character in a black
 * coat on a black ground is a silhouette, and the template's own grey is a
 * better default. What must stay pure black is the EDGE around the whole
 * image, because the plate is composited in `screen` and screen only drops
 * true black: a grey border would show as a lit rectangle over the page.
 *
 * WHAT WAS DELIBERATELY NOT TAKEN FROM THAT PROMPT. It asks every tile for
 * dramatic forced perspective, which is right for nine film stills and wrong
 * here. This sheet exists so 03, 04 and 05 can read one face and one build
 * off it, and exaggerated depth is the thing that makes two panels disagree
 * about both - so the opposite is stated: same lens, same eye level, no panel
 * is a dramatic angle. */
/* THE BOARD. 04's first generation: the hero frame reframed into the page
 * the video model will be handed - one shot, six, or a first and a last.
 * IT IS 02's SHEET INSTRUCTION WITH A DIFFERENT SUBJECT, and deliberately so:
 * the hard part of both is the same, a model that would rather draw the
 * template's grid lines than obey them. What changes is what has to stay
 * constant. On a sheet it is the character against a flat tone; here it is the
 * character AND the place AND the light, because every panel is the same
 * scene from a different position rather than the same figure turned round.
 * The shape of it follows the contact-sheet prompt Babe sent on 2026-10-25 -
 * seamless tiles, each one a widescreen frame, no borders anywhere. */
/* THE CHARACTER ARRIVES AS A PICTURE, NOT AS A MEMORY - Babe, 2026-10-26,
 * looking at a board whose close-up was somebody else's face: "maybe we need
 * to use a reference image for it", "similar to sheets". The hero frame is
 * one angle of one moment, and a board asks for a face at six: the wide has
 * the character forty pixels tall and the close-up has to invent everything
 * the wide could not show. 02 exists for exactly this - it is the bible the
 * rest of the rail reads a face and a wardrobe off - and 04 was the one rung
 * after it that was not being handed one, although the sheet has been sitting
 * on the back of its left slot the whole time.
 * IT IS IMAGE 3, AND IT IS OPTIONAL. nano takes fourteen references; the
 * sentence says what each one is FOR, because a reference with no stated job
 * is one the model is free to average into the others - the mistake that
 * cost 04 its first clip. With no sheet the paragraph goes and the frame is
 * the only word on the character, which is what this rung did yesterday. */
/* AND A LIGHT IS A RELIGHT, WHICH THIS HAD TO BE TOLD ABOUT. The frame
 * arrives lit and graded and the sentence says so twice over - *already lit*,
 * and *the same light sources in the same places* - so a LIGHT picked on the
 * form would have been the artist's half of the prompt arguing with the
 * server's half, which is the two-directors trap this rail has paid for on
 * three rungs. Choosing one says the board is relit; AUTO says nothing and
 * the frame's own light stands. */
/* AND ONE FRAMING IS NOT A BOARD WITH ONE PANEL IN IT - Babe, 2026-10-27,
 * with a SINGLE SHOT result on screen: "04 does seem to be using 03 image".
 * It did: the result was image 1 on the left and a new close-up on the right,
 * which is the BEFORE-AND-AFTER failure `EDIT_SYS` forbids by name and
 * `PLACE_SYS` forbids as a grid - arriving on a third rung by a third route.
 * Everything in this sentence was written for several panels, so on a single
 * framing the word PANEL was the whole invitation: a model told to fill a
 * template with panels, and never told that the new framing REPLACES the
 * picture it was given, will put them side by side. One flag, because the
 * job either has panels or it does not, and the paragraphs that differ are
 * the ones that say the word. */
/* AND 04's TWO JOBS IN THE ENCODER'S REGISTER. 266 words joined to the
 * front of the prompt, in front of a panel list that is itself a sentence
 * per panel - and the open rows have no third reference, so a third of what
 * the long version says is about a sheet they were never handed.
 * WHAT SURVIVES IS THE TEMPLATE'S TWO LIES AND THE CONTINUITY. A blank page
 * is a page to FILL and not to copy - the divisions and the labels are the
 * two things a model hands straight back - and every panel is one moment
 * from a different camera position, which is the whole difference between a
 * board and six pictures. The relight swaps one clause, the way it does in
 * the long one, because a light picked on the form and a sentence that says
 * keep image 1's light are the two-directors trap.
 * AND THE SINGLE BRANCH KEEPS ITS REFUSAL. "Not a grid, and image 1 is
 * nowhere in it" is four words doing the work of the paragraph that was
 * written the day a single framing came back as a diptych of the picture it
 * was given. (*) Mine. */
/* AND THE TWO PICTURES ARE NAMED BY THE ENCODER THAT READS THEM, the way
 * `PLACE_LINE` and `SHEET_LINE` take theirs: qwen reads image_1 and image_2
 * and is happy with the words, Klein reads <ref_image_0> and <ref_image_1>.
 * The addresses and the words describing them cannot disagree. */
/* AND A NAME THAT OPENS A SENTENCE IS CAPITALISED, which is a fact about
 * prose rather than about the model: qwen reads words and `image 1` at the
 * head of a sentence is a typo, while a token's first character is `<` and
 * comes back unchanged. */
const Cap = (t) => String(t).charAt(0).toUpperCase() + String(t).slice(1);

const BOARD_LINE = (light, single, hasPage, one = "image 1", two = "image 2") =>
  (single
    /* AND IT LEADS WITH THE RE-FRAME - Babe, 2026-10-27, with FRAMING on
       EXTREME CLOSE-UP and 100MM MACRO on the lens: "the image looks the
       same", "are the camera and light prompts appended to this model?".
       They are, and they travel as the artist's half - but the first draft
       opened on three refusals and only then mentioned the camera, and an
       edit checkpoint at denoise 1 given a scene and a list of things not to
       do will hand the scene back. THE WORD THE LONG VERSION HAS AND THIS
       ONE DID NOT IS *REPLACES*: a framing that sits beside image 1 is a
       suggestion, one that replaces it is the job. */
    ? `Re-frame the scene in ${one}: move the camera as the line below says `
      + `and let that framing REPLACE ${one}'s - a different distance and a `
      + "different amount of the scene, same character, same room. One "
      + `photograph, not a grid, not a split screen, and ${one} is nowhere `
      + "inside it. "
      /* AND IT SENDS NO PAGE AT ALL NOW - Babe, 2026-10-27, on one run:
       * "aspect ratio is worse now", "added white bars", "should also be
       * an extreme close-up". Three symptoms of one thing: a layout page of
       * ONE panel says nothing a width and a height do not, and it costs
       * the whole of what it says - the model paints the template’s white,
       * the page’s ratio outranks the frame’s, and a second reference
       * takes attention off the only instruction on the screen. The board
       * keeps its page, because there the page IS the job. */
    : `A shot board of one moment. ${Cap(one)} is the scene. ${Cap(two)} is a blank `
      + "layout page: fill its panels edge to edge, never copy its lines, "
      + "gutters or labels. Every panel is that same moment from a different "
      + "camera position. ")
  /* AND ITS WHITE IS A SHAPE, NOT A COLOUR - Babe, 2026-10-27, on a single
   * framing that came back as a photograph between two tall white blocks.
   * The template is drawn as flat white on black so its divisions are
   * unmistakable at a glance, and a model handed that will paint the white.
   * The long version says so in a sentence and a half; this is the clause,
   * and it was the one I cut that the picture actually needed. */
  + (hasPage
      ? `The white and black of ${two} are a shape to follow, never colours `
        + "to copy: nothing in your picture is white or black because the "
        + "page was. "
      : "")
  + "The same character, face, costume and place"
  + (light ? ", relit as described below" : ", the same light and grade")
  + (single ? ". This framing:" : ". The panels:");

/* AND FREESTYLE IS THREE FACTS: which picture is the scene, that the person
 * in it is theirs and keeps that face, and that nothing is added to what they
 * asked for. The long version says the same in sixty. */
const FREE_LINE = (one = "Image 1") =>
  `${Cap(one)} is the scene. The person in it is the character and keeps that `
  + "face. Do exactly what is asked and nothing more - no panels, no grid, no "
  + "split screen, no border and no text unless the words below ask for one:";

const BOARD_SYS = (hasSheet, light, single, hasPage) =>
  (single
    ? "You are shooting one frame of this scene, as a single photograph. "
    : "You are building a shot board as a single image. ")
  + "Image 1 is the scene: a character in a place, already lit and already "
  + "graded. "
  /* AND A SINGLE FRAMING SENDS NO PAGE AT ALL SINCE 2026-10-27, so the
   * paragraph that explains one is gone with it rather than describing a
   * reference the graph no longer has. See `BOARD_LINE` for the three
   * symptoms that bought this. */
  + (!hasPage
      ? ""
      : single
      ? "Image 2 is a blank layout template, not a picture: it is the shape of "
        + "the frame you are filling, and its written label is an instruction "
        + "to you. It is drawn as a flat white panel on black only so that its "
        + "shape is unmistakable: those are not colours to copy, and nothing in "
        + "your image is white or black because the template was. "
        /* AND NO BLACK BORDER ON ONE PHOTOGRAPH - Babe, 2026-10-27, looking
         * at a single framing in the slot: "i also noticed this one has black
         * borders on the sides". It was asked for, in these words, and the
         * reason was never about a single frame: the EDGE must be pure black
         * on a SHEET because the plate composites in screen mode, and screen
         * only drops true black. One photograph is not composited that way,
         * it is the thing in the box - and a border baked into it is a
         * letterbox that 05 then inherits as its slate. The board keeps the
         * clause, because a board really is a sheet. */
      : "Image 2 is a blank layout template, not a picture: it shows where "
        + "each panel goes, and its divisions and written labels are instructions to "
        + "you. Follow its divisions exactly and never draw them. It is drawn as flat "
        + "white panels on black only so that its divisions are unmistakable: those "
        + "are not colours to copy, and nothing in your image is white or black "
        + "because the template was. "
        + "The panels sit where the template puts them and meet each other directly, "
        + "with no gap, no gutter, no dividing line and no frame or outline drawn "
        + "between them. Around the outside of the whole image is a narrow border of "
        + "pure black, the same width on all four sides, and nothing is drawn in it. "
        + "Each panel is a complete widescreen cinematic frame of its own, not a crop "
        + "of its neighbour, and each one shows the same moment of the same scene "
        + "from the position its label names. ")
  + (single
      ? "THE RESULT IS ONE PHOTOGRAPH. One continuous frame: no panels, no "
        + "grid, no split screen, no inset, no diptych and no before-and-after "
        + "pair. Image 1 is not reproduced anywhere in it, at any size - the "
        + "framing described below REPLACES it rather than sitting beside it. "
        + "It is the same scene: the same character, the same face, the same "
        + "costume and the same props; the same location, the same time of day, "
        + (light ? "" : "the same light sources in the same places, ")
        + "the same colour grade. What changes is where the camera is and how "
        + "much of the scene it holds - nothing else. A frame that invents a new "
        + "room, a new wardrobe or a new time of day is wrong even if it is a "
        + "better picture. "
      : "EVERY PANEL IS THE SAME SCENE. The same character, the same face, the same "
        + "costume and the same props; the same location, the same time of day, the "
        + (light ? "" : "same light sources in the same places, ")
        + "the same colour grade. What changes "
        + "between panels is where the camera is and how much of the scene it holds - "
        + "nothing else. A panel that invents a new room, a new wardrobe or a new time "
        + "of day is wrong even if it is a better picture. ")
  + (light
      ? (single
          ? "THE FRAME IS RELIT, and the words below say how. Image 1 gives the "
            + "place, the character and what is in the frame; it does not give "
            + "the light. "
          : "THE WHOLE BOARD IS RELIT, and the words below say how. Image 1 gives "
            + "the place, the character and what is in the frame; it does not give "
            + "the light. Every panel is lit that one new way, from the same "
            + "sources in the same places, so the six still read as one moment. ")
      : "")
  + (hasSheet
      ? "Image 3 is that character's reference sheet: several panels of the "
        + "same person, lit flat on plain ground. Read the character off it - "
        + "the face, the hair, the build, the costume and everything they wear "
        + "or carry - and use it wherever image 1 does not show enough, which "
        + "is every close shot. Take NOTHING ELSE from it: its panels, its "
        + "framing, its flat light and its plain ground belong to the sheet, "
        + "and the place, the light and the grade of every panel you draw come "
        + "from image 1. "
      : "")
  + "No text, no numbers, no captions, no watermark and no "
  + (single ? "frame or border drawn inside the picture." : "panel borders.");

/* FREESTYLE, WHICH IS A JOB AND NOT THE ABSENCE OF ONE - Babe, 2026-10-26:
 * "custom is just wanter the user wants to create, doesnt even have to be a
 * board, it can be freestyle".
 *
 * THE OBVIOUS VERSION IS `raw`, AND IT IS WRONG HERE. That flag skips the
 * rung's scaffolding so a line you typed is not talked over - but this rung's
 * nano graph carries 01's become-someone instruction in its own
 * `system_prompt`, which is what the model falls back to when nothing is
 * patched there. Sending nothing would not leave the model undirected; it
 * would leave it directed by the wrong rung.
 *
 * SO FREESTYLE STILL SAYS WHAT THE PICTURES ARE and then gets out of the way.
 * No contact sheet, no panels, no layout of any kind unless the artist asks
 * for one in their own words - and every rule the board has about keeping one
 * character across six frames is gone with it, because there is only the one
 * frame they asked for. */
const FREE_SYS = (hasSheet) =>
  "The artist's own words are below and they decide what this picture is. "
  + "Image 1 is the scene they are working from: their character in a place, "
  + "already lit and already graded. "
  + (hasSheet
      /* IMAGE 3, NOT IMAGE 2, AND THE GAP IS DELIBERATE. The sheet is wired
       * to node 476 and the graph puts that on `model.images.image_3`; the
       * template's loader is simply not in this job, so the model is handed
       * image 1 and image 3 and is addressed by the names it was handed.
       * Re-pointing the sheet at 475 to close the gap would mean a mode
       * restating the whole `inputs` table - a shallow merge replaces it -
       * which is the duplicate-key bug this file has paid for once. */
      ? "Image 3 is that character's reference sheet: several panels of the "
        + "same person, lit flat on plain ground. Read the character off it - "
        + "the face, the hair, the build, the costume and everything they wear "
        + "or carry - wherever image 1 does not show enough. Take NOTHING ELSE "
        + "from it: its panels, its framing, its flat light and its plain "
        + "ground belong to the sheet. "
      : "")
  + "Whatever they ask for, the person in it is that character and keeps that "
  + "face. "
  + "Do exactly what they say and nothing they did not: no contact sheet, no "
  + "panels, no grid, no split screen and no border unless their own words "
  + "ask for one. "
  + "No text, no numbers, no captions and no watermark.";

/* AND THE SAME SHEET IN THE ENCODER'S REGISTER, 2026-10-27. Babe: "we're
 * just trying to setup these workflows for local / open weights models".
 * MEASURED BEFORE WRITING: 02 sends nano 291 words in its own
 * `system_prompt` input and sends qwen the same 291 JOINED TO THE FRONT of a
 * prompt that already carries a sentence per panel - four hundred words into
 * a text encoder at cfg 1, where `qwen-image-21-edit`'s own template ships
 * FOUR. Every clause after the first few is competing with the panel list,
 * which is the one part of this that is actually the job.
 * SO WHAT SURVIVES IS WHAT THE PANEL LIST CANNOT SAY: that this is a contact
 * sheet, which of the two pictures is the character and which is the blank
 * page, that the page is to be FILLED and not copied - the gutters and the
 * labels are the two things every early sheet drew back at us - and that one
 * face has to hold across the panels. It ends on a colon, so the panels are
 * the sentence rather than a second instruction after one.
 * NANO KEEPS THE LONG ONE. A sheet is a layout job before it is a rendering
 * job and nano is unusually good at being told how. (*) Mine. */
/* AND IT TAKES THE TOKEN NAMES, because the open rows do not address their
 * references alike: qwen's encoder reads `image_1` and `image_2` and is
 * happy with the words, and Klein's reads `<ref_image_0>` / `<ref_image_1>`
 * and says so in its own node description. Same sentence, two vocabularies -
 * the pattern `STYLE_SYS` and `EDIT_LINE` already follow on 01. */
const SHEET_LINE = (one = "Image 1", two = "Image 2") =>
  "A character contact sheet. " + cap(one) + " is the character. " + cap(two)
  + " is a blank layout page: fill its panels, never copy its lines, gutters "
  + "or labels. The same face, hair and build in every panel, flat even "
  + "light, plain ground, no text anywhere:";

const SHEET_SYS =
  "You are building a character reference sheet as a single contact sheet image. "
  + "Image 1 is the character. "
  + "If a second image is given it is a blank layout template, not a picture: it "
  + "shows where each panel goes, and its grid lines and written labels are "
  + "instructions to you. Follow its divisions exactly and never draw them. "
  + "It is drawn as flat white panels on black only so that its divisions are "
  + "unmistakable: those are not colours to copy, and nothing in your image is "
  + "white or black because the template was. "
  + "The panels sit where the template puts them and meet each other directly, "
  + "with no gap, no gutter, no dividing line and no frame or outline drawn "
  + "between them, and each panel is a complete picture of its own rather than a "
  + "crop of its neighbour. Around the outside of the whole image is a narrow "
  + "border of pure black, the same width on all four sides, and nothing is drawn "
  + "in it. "
  + "Every panel is the same character, in the same costume, the same hair and "
  + "the same props, lit identically by one key light, at the same scale and the "
  + "same eye level, on the same lens - no panel is a dramatic angle. "
  + "The face in every panel is the face of image 1, with the same "
  + "bone structure, eyes, nose, mouth and age. Behind the character is one flat "
  + "solid tone, the same tone in every panel, with no floor, no horizon, no "
  + "scenery and no shadow cast onto anything - dark enough to sit back, light "
  + "enough that a black costume still reads against it. The final image carries "
  + "no text, no lettering, no labels, no captions, no numbers and no grid lines.";

/* READING A CHARACTER OFF A PICTURE. Nine fields, and the only ones a model
 * can honestly answer are the ones a picture shows - so this says which are
 * seen and which are guessed, and demands the guesses anyway, because a blank
 * field in a character bible is worse than a reasonable guess somebody can
 * correct. The card is a draft; a person has the last word on every line.
 *
 * JSON ONLY, AND NO FENCES. Models wrap JSON in ``` by habit; the client
 * strips them, but asking is cheaper than stripping. */
const TRAITS_SYS =
  "You are reading a character sheet off a single picture of a character. "
  + "Answer with one JSON object and nothing else: no prose before or after it, "
  + "no code fence, no markdown. Every key you are asked for is present, and "
  + "every value is a short phrase in plain lower case - a few words, never a "
  + "sentence and never a full stop. Say what the picture actually shows for "
  + "the things it can show. For the things it cannot show, give the most "
  + "likely answer for this character as you see them and give it plainly, "
  + "without hedging and without saying you are guessing. If something is "
  + "genuinely impossible to judge, use an empty string for that key rather "
  + "than inventing a detail that contradicts the picture.";

/* THE HALF OF A CHARACTER NO REFERENCE IMAGE CARRIES. The card's five fields
 * split cleanly down the `vis` flag: `features` is what the sheet already
 * shows and goes into 02's own sentence, and the rest are facts a picture
 * cannot hold however good it is - how they are, how they move, how they
 * sound. They were composed, sent to 02 and thrown away; this is where they
 * reach the rungs after it.
 *
 * NAME NEVER TRAVELS. It is how a person reads the record back, and a model
 * handed a name either letters it onto the picture or casts somebody famous
 * with it. It lives in the sidecar and nowhere else.
 *
 * AND IT IS PERFORMANCE, NEVER APPEARANCE, WHICH IS BOTH WHAT BABE ASKED FOR
 * AND WHAT 05 CANNOT RISK. Babe, 2026-10-25, on cutting the card to five:
 * "this is for the video model to add any extra motion context". And
 * ByteDance refuses a prompt that describes a person with an opaque
 * job_failed and no reason attached - so the sentence is told twice over that
 * appearance arrives as a reference image and not as words. `features` is
 * held back here for that reason as well as for being on the sheet.
 *
 * VOICE ONLY WHERE THERE IS SOUND. An image model handed a voice is being
 * given a fact it has no way to use, which is noise in the prompt. */
const TRAIT_NOTE = (traits, moving) => {
  const say = (v) => String(v).trim().toLowerCase().replace(/\.$/, "");
  const t = traits || {};
  const said = [];
  if (t.character) said.push(`their manner is ${say(t.character)}`);
  if (t.movement) said.push(`their movement is ${say(t.movement)}`);
  if (moving && t.voice) said.push(`their voice is ${say(t.voice)}`);
  if (!said.length) return "";
  return `What the reference cannot show about this character: ${said.join("; ")}. `
    + (moving
        ? "Let that shape the performance - how they carry themselves, their "
          + "timing, their presence - and never their appearance, which comes "
          + "from the reference images alone."
        : "Let that shape how they hold themselves and what their face is "
          + "doing, and nothing about their appearance, which comes from the "
          + "reference alone.");
};

/* THE PRESET IS A GUIDE, NOT A SUBJECT - Babe, 2026-10-26, looking at a bald
 * diver: "this feels more like a restyle of the preset, and so i think we'll
 * want the preset image to only be used as a guide for the front view
 * portrait, not the look or style", "its like for scale / angle", "otherwise
 * all character will look like the preset".
 *
 * THE GRAPH'S OWN SYSTEM PROMPT IS RIGHT ABOUT A PERSON AND WRONG ABOUT A
 * MANNEQUIN. It says image 1 is "a real person" whose face "must survive
 * exactly" - which is the whole job of this rung when you bring a photograph
 * of yourself, and a instruction to keep a bald grey bust when you have not.
 * Every character made from the preset was going to be that bust restyled.
 *
 * SO WHEN THE SOURCE IS THE PRESET, THIS REPLACES IT. Everything the
 * mannequin is good for is kept - the crop, the distance, the eye level, how
 * much of the frame the head fills - and everything it is not is refused by
 * name: its face, its bald head, its grey material, its lighting. The
 * character comes from the words and the reference instead.
 *
 * IT IS ONE SENTENCE DIFFERENT PER REFERENCE, because image 2 is optional
 * here exactly as it is for the ordinary job. */
const GUIDE_SYS = (hasRef) =>
  "You are a character photographer. "
  + "Image 1 is NOT a person and NOT the subject: it is a grey featureless "
  + "mannequin bust, included only as a framing guide. Take from it the crop, "
  + "the camera angle, the eye level, the camera distance and how much of the "
  + "frame the head fills - nothing else. Never keep its face, its blank "
  + "features, its bald head, its grey material, its surface or its lighting, "
  + "and never return a mannequin, a statue, a bust or a figure. "
  + (hasRef
      ? "Image 2 is the style: costume, headwear, masks, props, hair, grooming, "
        + "lighting and colour grade come from it, and never its face. "
      : "")
  + "Produce one photograph of a real human character as described below, "
  + "invented from the description: their own face, hair, skin and build, "
  + "framed the way image 1 is framed. Always return an image.";

/* AND AN IMPORT IS WHATEVER SOMEBODY BROUGHT - Babe, 2026-10-26: "import is
 * more custom, so the prompt would have to just reference it as any image
 * input".
 *
 * THE GRAPH'S OWN INSTRUCTION PROMISES A FACE. It opens "Image 1 is the
 * subject: a real person", and an import is the one path where that is a
 * guess: it may be a photograph of someone, a character somebody drew, a
 * figure, an object. A model told it is looking at a real person and handed a
 * drawing will invent the person it was promised.
 *
 * SO IT NAMES THE SUBJECT WITHOUT NAMING WHAT IT IS, and says what to carry
 * across in terms that hold either way: whatever makes this subject
 * recognisable, and the face exactly IF there is one. */
const CUSTOM_SYS = (hasRef) =>
  "You are a character photographer. "
  + "Image 1 is the subject. It may be a photograph of a person, a drawing, a "
  + "character, a figure or an object - do not assume which. Whatever makes "
  + "that subject recognisable must survive: if it is a person or a face, keep "
  + "it exactly, including bone structure, eyes, nose, mouth, age and any "
  + "glasses; if it is not, keep the shape, markings and proportions that "
  + "identify it. Keep the crop, the camera angle and the camera distance of "
  + "image 1. "
  + (hasRef
      ? "Image 2 is the style: costume, headwear, masks, props, hair, grooming, "
        + "lighting and colour grade come from it, and never its face. "
      : "")
  + "Produce one photograph of that subject as the character described below. "
  + "Always return an image.";

/* AND A WEBCAM FRAME IS YOU, WHICH IS A THIRD JOB AGAIN - Babe, 2026-10-26:
 * "i think for web-cam tho the system prompt should be different since we are
 * turning our self into a character".
 *
 * THE LIKENESS IS THE WHOLE POINT AND THE SNAPSHOT IS NOT. The graph's own
 * instruction keeps the face exactly, which is right, and then keeps the
 * framing, angle, distance, pose and expression "exactly" - which on a
 * webcam frame also keeps the room behind you, the flat ceiling light, the
 * half-second expression and the look of a video call. Every character made
 * this way came back as someone at a desk in a costume.
 *
 * SO THE GEOMETRY SURVIVES AND THE SNAPSHOT DOES NOT. The crop, the angle and
 * the distance are kept, because a headshot has to stay a headshot; the room,
 * the light and the webcam's own look are refused by name, and what replaces
 * them is the style - which is the one thing this rung is for.
 *
 * IT SAYS THE FACE IS YOURS TWICE, because that is the half a model will drop
 * first when it is asked to restage a photograph. */
const CAM_SYS = (hasRef) =>
  "You are a character photographer. "
  + "Image 1 is the subject: a real person, photographed on a webcam. Their "
  + "face must survive exactly - bone structure, eyes, nose, mouth, skin, age "
  + "and any glasses - and it must still be recognisably the same person. "
  + "Keep the crop, the camera angle and the camera distance of image 1. "
  /* BABE'S WORDS, 2026-10-27: "keep the exact same pose and facial
   * expression". THE EXPRESSION USED TO BE ON THE REFUSE LIST, as "the
   * casual expression of someone looking into a laptop" - written when the
   * worry was a dead-eyed snapshot and wrong about what a webcam actually
   * gives you. The run that finally worked came back wearing Babe's own
   * raised eyebrows, and that is the thing that makes a character read as
   * YOU rather than as a good portrait of somebody. The likeness is the
   * expression. So it is kept by name and the refusal list keeps only what
   * is genuinely the room's. */
  + "Keep the exact same pose and facial expression. "
  + "Do NOT keep anything else about the snapshot: not the room or wall behind "
  + "them, not its flat even light, and not the webcam's softness, noise or "
  + "colour. "
  + (hasRef
      ? "Image 2 is the style: costume, headwear, masks, props, hair, grooming, "
        + "lighting and colour grade come from it, and never its face. "
      : "")
  + "The result is a deliberate photograph of that person as the character "
  + "described below - lit for the character, in the character's own "
  + "surroundings. Always return an image.";

/* THE AGENT THAT HELPS WRITE A STYLE - Babe, 2026-10-26: "can we wire up the
 * llm to help with a style prompt". The panel, the transcript and the waiting
 * state have been real since 04 grew them; this is the thing behind them.
 *
 * IT IS THE SAME MACHINE THE TRAITS CARD ALREADY USES - GeminiNodeV3 into
 * PreviewAny, which is the only reason an answer in words reaches the job at
 * all - minus the image node, because this one is read a conversation rather
 * than a picture.
 *
 * TWO FIELDS, AND THE SECOND ONE IS THE POINT. `say` is what it tells you;
 * `prompt` is the line it is proposing, and the page only lights RUN and
 * writes into the box when there is one. So "what are you going for?" leaves
 * the rung alone and a finished sentence arms it - which is exactly the rule
 * `answered(text, direction)` was built around.
 *
 * IT WRITES THE PROMPT THIS RUNG ACTUALLY TAKES. 01 keeps the face from the
 * source and takes wardrobe, hair, props and light from the style - so the
 * line it proposes is about those, never about the face, and never an
 * instruction to the model about image_1 and image_2. That scaffolding is the
 * server's and is added after. */
/* ONE AGENT, THREE QUESTIONS, AND THE ENVELOPE IS THE SAME EVERY TIME. What
 * changes from rung to rung is the SUBJECT it is helping to write; how it
 * answers does not. So the JSON contract, the ask-once rule and the "name
 * things you could photograph" rule are written once here and each rung
 * declares only its own half.
 *
 * IT WAS ONE STRING AND EVERY RUNG GOT 01's. The panel was built on 01 and
 * then put on 04 and 03, and all three were telling the model it was writing
 * a CHARACTER STYLE - so asking 03 for help with a place was answered by
 * something whose instructions forbid describing anything but wardrobe. The
 * rung rides in as `about` and reaches no node, the way `lens` and `face`
 * already do. */
/* THE AGENT'S PER-MODEL REGISTER, read once at boot the way a graph is - so
 * editing it needs the same restart and nothing has to remember to reload.
 * It answers one question that nothing else on this server answers: how long
 * a line the chosen model can actually be steered by. See agents/models.json,
 * whose own "_" says why it exists and what deliberately is NOT in it. */
let VOICES = { default: "chat", voices: { chat: "" }, models: {} };
try {
  VOICES = JSON.parse(
    readFileSync(new URL("./agents/models.json", import.meta.url), "utf8"));
} catch (err) {
  console.warn("  agents/models.json not read - the agent writes one register for every model");
}
const voiceFor = (model) =>
  (VOICES.voices || {})[(VOICES.models || {})[model] || VOICES.default] || "";

const AGENT_JOB = {
  style:
    "You help someone write one short line describing a CHARACTER STYLE. "
    + "Their own photograph is the subject; the line you write says what to turn "
    + "them INTO - wardrobe, hair, headgear, props, materials, era, the light and "
    + "the world it belongs to. Never describe their face, age, build or likeness: "
    + "those come from their photograph and are not yours to change. ",
  /* AND EDIT IS THE OTHER HALF OF THE SAME RUNG - Babe, 2026-10-27, with a
   * finished scientist back in 01's SOURCE and the EDIT tab pressed: "and so
   * say like a load the image back in a use the edit mode is the agent
   * lookig at the image?". It is - `ensureLeft` has sent the left slot on
   * every rung since the panel was wired - but it was being handed the STYLE
   * job and told the picture was "the subject you are dressing", so it wrote
   * a whole new character line for a tab whose entire job is to change one
   * named thing and leave the rest alone. THE MODE IS THE JOB WHERE A RUNG
   * HAS MODES, which is the rule 04's board already runs on.
   * AND THE LINE IS SHORT ON PURPOSE. The failure this fixes is a sentence
   * that re-describes the whole picture: every word spent on what is already
   * there is a word the edit model reads as something to preserve, and on
   * the open rows it is joined to a scaffolding that says so again. */
  edit:
    "You help someone write ONE instruction that changes one thing in a "
    + "photograph that already exists. Name the change and nothing else: what "
    + "to add, remove, replace or recolour, and where it is in the frame if "
    + "that is not obvious. Do not describe the person, the place, the light "
    + "or anything you are not changing - all of it is already in the picture "
    + "and saying it again is asking for it to be kept rather than changed. ",
  /* THE PLACE IS EMPTY, which is the same thing this rung's own scaffolding
   * says twice over: the character arrives from the sheet, and a figure
   * already standing in the description is one the image model has to
   * remove. */
  place:
    "You help someone write one short line describing an ENVIRONMENT - the "
    + "room, street, landscape or interior a character is about to be standing "
    + "in. "
    + "The character already exists and arrives as a picture, so never describe "
    + "the person, their face, their wardrobe or what they are doing: write the "
    + "place and nothing else, and write it empty of people. Say what is there "
    + "and what it is made of, the time of day, the weather, and where the "
    + "light comes from. ",
  /* AND A BOARD IS NOT ONE SHOT - Babe, 2026-10-26: "i think the agent should
   * have context when doing a board of 6 frames", "so the prompt can be more
   * structure for 6 frames in a grid". It was answering BOARD with a single
   * framing - "a wide, low-angle shot looking up through the deep blue water"
   * - which is a perfect answer to the OTHER tab and spends the whole
   * direction on a sixth of the page.
   * IT IS HANDED THE SIX BY NAME, from the layout table the template is drawn
   * from, so there is no second list of panel names to drift from the
   * drawing. What it writes is a beat each, in that order: the panels are
   * decided and what happens in them is not. */
  board: (panels) =>
    "You help someone plan a SHOT BOARD: one moment of a scene, covered from "
    + "six camera positions at once and laid out as a grid. "
    + "The character, their wardrobe and the place are all settled and arrive "
    + "as pictures, so never describe any of them - and never invent a framing "
    + "or a camera position, because the six are already fixed"
    + (panels ? ", in this order: " + panels + ". " : ". ")
    + "Write what is HAPPENING: one moment, and then one short beat for each "
    + "of the six in that order, saying what that position sees of it - what "
    + "the character is doing, what is around them, what the light is doing. ",
  /* AND ON 05 NOTHING IS OPEN BUT THE MOVEMENT. The character, the wardrobe,
   * the place and the framing have all been decided by the four rungs behind
   * it and arrive as pictures, so the only question left is what moves.
   * AND THE PROVIDER ENFORCES THAT, WHICH IS WHY IT IS SAID TWICE. ByteDance
   * refuses a prompt that describes a person with an opaque `job_failed` and
   * no reason attached - the same rule `TRAIT_NOTE` is written around - so a
   * line about the character's face or build does not come back worse here,
   * it does not come back at all. */
  motion:
    "You help someone write one short line describing MOVEMENT - what happens "
    + "over a few seconds in a shot that already exists. The character, their "
    + "wardrobe, the place and the framing are all settled and arrive as "
    + "pictures, so never describe the person, their face, their build, their "
    + "age or what they are wearing, and never describe the room: write what "
    + "MOVES. Say what the character does, how the camera follows it, and what "
    + "else in the frame moves with them - cloth, hair, dust, water, light. ",
  /* AND 06 IS THE ONLY RUNG WHERE THE THING BEING CHANGED IS A CLIP. Babe,
   * 2026-10-26, adding the agent to this panel. Its four modes - reshoot,
   * swap, edit, extend - are one shape: something already exists and you are
   * saying what becomes of it, which means the half that is usually left
   * unsaid (what must NOT move) is half the instruction here.
   * (*) ONE JOB FOR FOUR MODES. 04's board earned its own entry because the
   * answer's SHAPE differs there; these four differ in what they keep, which
   * is a thing to say inside one sentence rather than four jobs. */
  change:
    "You help someone write one short line saying what should happen to a "
    + "CLIP THEY ALREADY HAVE. The character, their wardrobe and the place "
    + "are settled and arrive as pictures, so never describe the person, "
    + "their face, their build or their age. Write the change and the thing "
    + "it must not break: what becomes different, and what stays exactly as "
    + "it is - the timing, the camera, the performance, or whatever of those "
    + "they have said matters. ",
  /* AND THE SHOT IS NOT A PLACE OR A COSTUME. 04 has the character and the
   * room already; what is open is where the camera is. */
  shot:
    "You help someone write one short line describing a SHOT - how to frame a "
    + "scene that already exists. The character, their wardrobe and the place "
    + "are all settled and arrive as pictures, so never describe any of them: "
    + "write where the camera is and what it holds. Say the distance, the "
    + "height, the angle and what is in the foreground and behind. ",
};

/* HOW LONG THE ANSWER IS, WHICH IS NOT THE SAME QUESTION AS WHAT IT IS ABOUT.
 * Every rung but one wants a sentence; the board wants six beats, and the
 * shared "one or two sentences, no lists" would have forbidden the thing that
 * rung asked for. One default and one exception, rather than four copies of a
 * sentence that is the same on three of them. */
const AGENT_SHAPE = {
  "": "The prompt is one or two sentences, concrete and specific, naming things "
    + "you could photograph: materials, surfaces, wear and damage, the quality "
    + "and direction of the light. No lists, no camera settings, no "
    + "instructions to an image model, no mention of a reference image. ",
  edit:
    "The prompt is ONE short sentence in the imperative - the change itself, "
    + "ten or fifteen words. No description of the rest of the picture, no "
    + "camera settings, no instructions to an image model, no mention of a "
    + "reference image. ",
  board:
    "The prompt is one sentence naming the moment, then the six beats in "
    + "order, each a short phrase, separated by semicolons - nothing else, no "
    + "numbering, no panel names repeated back, no camera settings, no "
    + "instructions to an image model, no mention of a reference image. "
    + "Name things you could photograph: what moves, what is held, what the "
    + "light is doing. ",
  /* AND MOTION IS A TIMELINE, NOT A SENTENCE - Babe, 2026-10-26: "so if i say
   * two shots it knows, [shot 01 0-2s)", with Higgsfield's own Seedance 2.5
   * guide and its worked example beside it. The model reads second ranges and
   * shot labels and cuts on HARD CUT; the agent was writing a paragraph that
   * could have been three seconds or fifteen, for a row that says five.
   * THE LENGTH IS ON THE ROW AND THE AGENT COULD NOT SEE IT, which is the
   * whole of why it could not write a timeline. `seconds` rides along and
   * reaches no node, the way `panels` does on 04.
   * ONE SHOT UNLESS THEY ASK. A cut is a decision, and a rung that invents
   * one has answered a question nobody put to it - the same reason AUTO on
   * 04's dials is the absence of an answer rather than an answer. */
  /* AND THE LENGTH DECIDES HOW MANY SHOTS ARE EVEN POSSIBLE - Babe,
   * 2026-10-26: "based on duration it needs to know how many shots are
   * possible". No shot under 1.5s is worth cutting to, which the guides agree
   * on, so the ceiling is the duration divided by that - two at five seconds,
   * six at ten. It is said as a number rather than left to arithmetic,
   * because a model asked to divide will sometimes answer. */
  motion: (secs) =>
    "The prompt is the shot plan for a clip exactly " + secs + " seconds long. "
    + "Write ONE shot unless they have asked for more, and never more than "
    + Math.max(1, Math.floor(secs / 1.5)) + " - there is no room. Each shot is "
    + "`Shot 1 (0.0s to 2.0s):` and then what happens and where the camera "
    + "goes, ending in `HARD CUT.` on every shot but the last. The ranges run "
    + "back to back and add up to exactly " + secs + "s, and no shot is "
    + "shorter than 1.5s. Time a particular moment inside a shot as "
    + "`At 1.4s ...`. "
    + "End with one line beginning `AUDIO:` giving the ambience, because this "
    + "model makes its own sound - say `No music.` unless they asked for some. "
    + "Say where the camera goes, never what lens or stock it is on, and "
    + "nothing else: no other headings, no instructions to the model, no "
    + "mention of a reference image. ",
  /* AND 06 NEVER GOT THE TIMELINE, ON THE RUNG THAT LOOPS. Babe, 2026-10-27,
   * on a reshoot of a 6.9s take: "whats interesting tho is that it did not
   * use all my video / words". `HELP_ABOUT[6]` is `change` and there was no
   * `change` here, so it fell through to the default shape - ONE OR TWO
   * SENTENCES, NO LISTS - and the agent was being told to write two sentences
   * for a seven-second performance. Nothing anchored what happens at 2s
   * rather than at 5s, so the model filled the gap itself and summarised.
   * The whole apparatus was built for 05 on 2026-10-26 and stopped there.
   *
   * IT IS NOT 05's SHAPE, THOUGH, AND THE DIFFERENCE IS THE CUT. On 05 the
   * length is a decision and shots are the artist's to ask for; here the clip
   * you brought already has a performance in it and the job is to cover it,
   * so this asks for ONE continuous shot and times the beats inside it. A cut
   * invented here would cut away from the take the rung exists to follow.
   *
   * AND THE DIALOGUE IS THE HALF A SUMMARY LOSES FIRST. If there are words in
   * the take they are the spine of the timing, so they are asked for by name
   * and timed - but only ever as words said, never as a description of who is
   * saying them, which is the likeness rule this rung already runs on. */
  change: (secs) =>
    "The prompt is the plan for a clip exactly " + secs + " seconds long, and "
    + "it has to cover ALL of it. "
    + "Write ONE continuous shot - the clip already has the performance in it "
    + "and your job is to say what happens across its whole length, not to cut "
    + "away from it. "
    + "Open with one sentence naming the shot, then time the beats through it "
    + "as `At 0.0s ...`, `At " + Math.max(1.5, Math.round(secs * 0.4 * 10) / 10)
    + "s ...`, `At " + Math.max(3, Math.round(secs * 0.8 * 10) / 10) + "s ...`, "
    + "in order, the last one no later than " + secs + "s, so nothing in the "
    + "take is left unaccounted for. "
    + "If they are speaking, put what is said in double quotes at the moment it "
    + "is said - the words only, never a description of the person saying them. "
    + "End with one line beginning `AUDIO:` giving the voice and the ambience, "
    + "because this model makes its own sound - say `No music.` unless they "
    + "asked for some. "
    + "Say where the camera goes, never what lens or stock it is on, and "
    + "nothing else: no other headings, no instructions to the model, no "
    + "mention of a reference image. ",
};

/* AND IT CAN SEE WHAT THE RUNG IS HOLDING - Babe, 2026-10-26: "so when you
 * use the agent it will have access to look at the slate right?". It could
 * not: `gemini-chat.json` was the traits machine MINUS the image, so the one
 * thing on the rail that is supposed to know what you just made was writing
 * about a shot it had never seen.
 * IT IS THE LEFT SLOT, ON EVERY RUNG, which is the rail's own rule arriving
 * in the agent: the left is what you have and the right is what you choose,
 * and the agent helps you write the right-hand side ABOUT the left-hand one.
 * So there is one picture and one call - `ensureLeft` - rather than a rule
 * per rung.
 * AND IT IS STILL NAMED, because a picture with no stated job is one the
 * model is free to describe back at you instead of writing from. What that
 * picture IS differs per rung, so the sentence sits beside the job's own and
 * is keyed the same way - a second table, not a second mechanism. */
const SEES_SCENE =
  "You can see the scene: the character in their place, already lit and "
  + "graded. Write about what is actually in it rather than inventing "
  + "something next to it. ";

const AGENT_SEES = {
  style:
    "You can see their photograph. It is the subject you are dressing: read "
    + "the crop, the angle and what is already in frame from it, and go on "
    + "saying nothing about their face, their build or their age. ",
  place:
    "You can see the character's reference sheet. It is there only so the "
    + "place you write suits them - never describe the person, and never put "
    + "them in the sentence. ",
  /* AND ON EDIT IT IS LOOKING AT THE THING BEING CHANGED, which is the same
   * picture the STYLE key calls the subject and a different fact about it. */
  edit:
    "You can see the photograph being edited. It is the thing being changed, "
    + "not a reference: everything in it stays unless the instruction you "
    + "write names it. Look at it so that what you ask for fits what is "
    + "already there - where the light comes from, what they are holding, "
    + "what is in reach - and then write only the change. ",
  /* SHOT AND BOARD ARE ONE RUNG LOOKING AT ONE PICTURE - the two jobs differ
   * in how much of the page they are writing for, not in what 04's left slot
   * is holding, so the sentence is written once and both keys point at it. */
  shot: SEES_SCENE,
  board: SEES_SCENE,
  /* AND THE PANEL COUNT IS NOT A SHOT COUNT - Babe, 2026-10-26: "the 6
   * frames in the slate does not equal to 6 shots", "its just a guide for the
   * look and feel still". Which is what a slate is for on this rail: 04
   * decided the character, the place, the light and the grade, and a board
   * shows them from six positions so there is something to read a face and a
   * wardrobe off. How many times the clip CUTS is 05's question and nobody
   * has answered it but the person typing - so the picture is told to say
   * nothing about it, in those words, because six panels in front of a model
   * being asked for a shot plan is six of something. */
  /* AND ON 06 IT CAN SEE THE CHARACTER AND NOT THE CLIP. The left slot's
   * front face is 02's sheet, which is who is in the shot; the clip being
   * changed is in the RIGHT slot, and the right-hand side is the one the
   * agent is helping to write rather than one it gets to look at. Saying so
   * is cheaper than a model guessing which of the two it has. */
  change:
    "You can see the character's reference sheet - who is in the clip, not "
    + "the clip itself. It is there so that what you write suits them; never "
    + "describe the person, and never put them in the sentence. ",
  motion:
    "You can see the slate: the shot as it was framed on the rung before. It "
    + "is a guide to the LOOK AND FEEL - the character, the place, the light "
    + "and the grade - and nothing else. If it is laid out as several panels "
    + "those are one moment seen from several camera positions, and how many "
    + "panels it has says NOTHING about how many shots to write: never read "
    + "six panels as six shots. Write about what is actually in the frame. ",
};

/* IT TAKES THE VALUES NOW, NOT FOUR POSITIONS. Every rung's `sys` on this
 * server is already `(v) => ...`, and this one had grown to `about, panels,
 * sees` with `seconds` about to be a fourth - at which point the only thing
 * holding the call together is the order of the arguments. */
const AGENT_SYS = (v) => {
  const about = v.about;
  const shape = AGENT_SHAPE[about] || AGENT_SHAPE[""];
  return (typeof AGENT_JOB[about] === "function"
    ? AGENT_JOB[about](v.panels)
    : (AGENT_JOB[about] || AGENT_JOB.style))
  + (v.look ? (AGENT_SEES[about] || "") : "")
  + "Answer with one JSON object and nothing else - no prose around it, no code "
  + "fence, no markdown - with exactly two keys: "
  + '"say", one or two sentences to the person in plain language, and '
  + '"prompt", the line itself. '
  + "If you have enough to write a line, write it and keep `say` to a sentence "
  + "introducing it. If you genuinely need one more thing to know, ask for that "
  + "one thing and leave `prompt` as an empty string - never ask twice in a row "
  + "and never ask for something they have already told you. "
  + (typeof shape === "function" ? shape(v.seconds || 5) : shape)
  /* A MEDIUM IS NOT AN ADJECTIVE - Babe, 2026-10-26, having asked for a look
   * "more like a 3d video game" and got back stylized, angular and clean:
   * "should it say something like in the style of a 3d video game". The
   * agent had understood perfectly and translated the answer into the
   * qualities a game render has, which is exactly what an image model cannot
   * work back from. The name of the medium is the one thing that has to
   * survive word for word. */
  + "AND IF THEY ASK FOR A LOOK, A MEDIUM OR A RENDERING STYLE - a film "
  + "stock, a decade, an illustration, a game engine, a camera - say it in "
  + "the prompt in those words, as plainly as they said it. Describing what "
  + "that medium looks like is not the same as naming it, and the model "
  + "cannot work back from the adjectives to the thing. "
  /* AND THE MODEL'S OWN REGISTER IS LAST, WHICH IS THE ONLY POSITION THAT
   * CAN WIN. The shape above is the JOB's opinion about the line - a board
   * wants six beats, a motion wants a timeline - and this is the MODEL's,
   * about how much of any of it that model can actually be steered by. The
   * job is right about what to say; the model is right about how much, and
   * a length rule that arrives before three more paragraphs of instruction
   * is a length rule nobody obeys. */
  + voiceFor(v.model);
};

/* WHAT THE REFERENCE IS, WHEN IT IS A BOARD - Babe, 2026-10-26, on a clip
 * asked for in two shots that came back in three: "it actually did 3 shots,
 * prob because of the board".
 *
 * THE SENTENCE THAT SAYS PANELS ARE NOT SHOTS WAS ON THE WRONG SIDE. It is in
 * `AGENT_SEES`, which talks to Gemini, and it worked - the agent wrote two.
 * Then SEEDANCE was handed a grid of six on image_1 with a two-shot plan
 * under it and nobody had told it what the grid was. The model counted.
 *
 * AND THIS RAIL HAS PAID FOR THE OTHER HALF ALREADY, ON 03: hand a model a
 * grid and it hands you a grid back, which is why `PLACE_SYS` says single
 * frame, no panels, no grid, in those words and early. 05 has the identical
 * reference and had no such sentence - it got away with it, which is not the
 * same as being told.
 *
 * IT IS A FUNCTION OF WHAT 04 DREW, AND THE PAGE ALREADY SENDS IT. The board
 * records `st(4).mode` and 05 passes it as `mode` precisely because the kind
 * of shot was chosen on the rung behind - so a single frame gets none of this
 * and only a board is explained. A sentence about panels in front of a model
 * holding one frame is a sentence inventing a grid. */
/* THE SAME JOB AS SEEDANCE'S, SAID IN H3'S OWN TAGS. The addressing
 * convention is per model and always has been - Seedance reads `@Image1`,
 * the partner H3 node reads `Image 1` in connection order, and the OPEN
 * weights node reads `<Picture 1>` / `<Video 1>` / `<Audio 1>` and says so
 * in its own description. A sentence written for one of them does not reach
 * the other, which is why this is a second scaffolding and not a second
 * argument to the first.
 *
 * AND THIS IS THE FIRST MODEL ON THE RAIL THAT RENDERS THE AUDIO LINE. H3 is
 * audio-native: voice, effects and music come out of the same forward pass as
 * the picture, and the model's own guide is blunt that a prompt with no sound
 * direction throws away half of it. 05's agent has been writing an `AUDIO:`
 * line since the timeline format landed and Seedance took it as a hint; here
 * it is the instruction. So the scaffolding asks for sound and then shuts up
 * about what it should be - that is the artist's, like the cuts.
 *
 * THE PANEL CLAUSE IS SHOOT_SYS'S, EARNED THE SAME WAY. 04 draws one framing
 * or six, and a grid handed to a video model comes back as a grid: this rail
 * paid for that on 03 and again on 05's first board. */
const H3_R2V_SYS = (mode, hasSheet) =>
  "Shoot this from the reference frames. "
  + "<Picture 1> is the frame to shoot: the character, the place, the light "
  + "and the grade are all in it, and every one of them carries into the clip. "
  + (hasSheet
      ? "<Picture 2> is that same character's reference sheet, and it is there "
        + "for one thing only - who they are at angles <Picture 1> does not "
        + "show. Take nothing else from it: its panels, its flat key light and "
        + "its plain grey ground belong to the sheet and not to this shot. "
      : "")
  + "Hold the character, the wardrobe and the lighting exactly as the "
  + "references have them and do not describe their appearance in words; move "
  + "the camera and the subject, and cut between shots, only as the direction "
  + "says. One continuous take unless it asks for a cut. "
  + "Give the clip its sound - voice, room, effects, whatever the direction "
  + "calls for. "
  + (mode === "sequence"
      ? "<PICTURE 1> IS A CONTACT SHEET, NOT A SHOT LIST. Its panels are ONE "
        + "moment seen from several camera positions, and they are there to "
        + "show you the character, the place, the light and the grade. The "
        + "number of panels is NOT the number of shots - the plan below is the "
        + "only thing that says when to cut, and if it names one shot the clip "
        + "does not cut at all. Never render the panels: no grid, no split "
        + "screen, no inset, no border. Every frame of the clip is one "
        + "continuous picture filling the whole image."
      : "");

/* RESOLUTIONSELECTOR TAKES A LABELLED STRING AND THE LABELS ARE NOT
 * GUESSABLE - "2:3 (Portrait)" is refused and "2:3 (Portrait Photo)" is not,
 * which is a trap this rail has already paid for once on the roll. The row
 * carries the bare ratio because that is what a person reads; this is what
 * goes on the wire, and it is a `cast` rather than an `options` list so the
 * cell is not eight strings wide. Verified against `get_node`, which is free. */
const AR_LABEL = {
  "1:1": "1:1 (Square)",
  "2:3": "2:3 (Portrait Photo)",
  "3:2": "3:2 (Photo)",
  "3:4": "3:4 (Portrait Standard)",
  "4:3": "4:3 (Standard)",
  "9:16": "9:16 (Portrait Widescreen)",
  "16:9": "16:9 (Widescreen)",
  "21:9": "21:9 (Ultrawide)",
};

/* AND A SIZE IS A MEGAPIXEL TARGET HERE, NOT A NAME. The node multiplies the
 * ratio out to the nearest 32, so these are the three the row offers said in
 * the only units it takes. 0.98 is the value the graph shipped and the one
 * the proven run was made at - 1344x768 at 16:9 - so 720p is that number
 * rather than an arithmetic 0.92 that would quietly change what this row
 * does. */
const AR_MP = { "480p": 0.41, "720p": 0.98, "1080p": 2.07 };

const SHOOT_SYS = (mode) =>
  "Shoot this from the reference frame. Hold the character, the wardrobe and "
  + "the lighting exactly as the reference has them and do not describe their "
  + "appearance in words; move the camera and the subject, and cut between "
  + "shots, only as the direction says. One continuous take unless it asks for "
  + "a cut. "
  + (mode === "sequence"
      ? "THAT REFERENCE IS A CONTACT SHEET, NOT A SHOT LIST. Its panels are "
        + "ONE moment seen from several camera positions, and they are there "
        + "to show you the character, the place, the light and the grade. The "
        + "number of panels is NOT the number of shots - the plan below is the "
        + "only thing that says when to cut, and if it names one shot the clip "
        + "does not cut at all. Never render the panels: no grid, no split "
        + "screen, no inset, no border. Every frame of the clip is one "
        + "continuous picture filling the whole image."
      : "");

/* PUTTING THEM SOMEWHERE. The input is a reference sheet - several panels of
 * one person - and the output is ONE photograph. That is the whole trap on
 * this rung: hand a model a grid and it will hand you a grid back, so this
 * says single frame, no panels, no grid, in those words and early.
 *
 * THE SHEET IS A SOURCE OF TRUTH, NOT A COMPOSITION. Every panel of it is the
 * same person, so the model is told to read the person off it - face, hair,
 * build, costume, the things they carry - and then forget the sheet's own
 * framing, lighting and ground entirely, because the place has its own.
 *
 * LIT BY THE ROOM. 02 lights everything with one key light on black so a face
 * can be read; a frame lit that way inside a corridor is a cut-out standing
 * in a photograph. The room's own light is what makes it one picture. */
/* IT IS AN ENVIRONMENT, NOT A PLACE - Babe, 2026-10-26. A place is where you
 * are; an environment is everything around you, which is what this rung
 * actually hands the model and what the character has to agree with.
 *
 * AND THE INTEGRATION IS THE WHOLE JOB NOW - Babe: "we need to make sure the
 * character is integrated, so the lighting, angle, etc should match the
 * environment". It said they are lit by the room and stand in it rather than
 * in front of it, which is the idea and not the instruction: an image model
 * handed a figure and a room will composite them, and every tell of that is
 * a separate thing to forbid. The camera, the light, the shadow and the grade
 * are named one at a time, and then the look of a cut-out is refused by
 * name. */
/* AND THE SAME PLACING IN THE ENCODER'S REGISTER. 385 words joined to the
 * front of the prompt was the longest scaffolding on the rail and the one
 * with the most to lose by it: 03's whole trap is that its input is a GRID,
 * and a model that stops reading before the no-panels clause hands a grid
 * straight back.
 * SO THE ORDER IS THE OPPOSITE OF THE LONG ONE. That version opens by
 * explaining the sheet and says "one photograph" a third of the way in; this
 * one says it first, because it is the thing that must survive being skimmed.
 * Then who to read off image 1, then what NOT to take from it - the panels,
 * the flat light and the plain ground, which is the compositing failure in
 * three words rather than three paragraphs.
 * WHAT IS DELIBERATELY DROPPED: the whole photographed-not-pasted paragraph.
 * It is the best writing in `PLACE_SYS` and it is written for a model that
 * reads four hundred words; here it would be four hundred words' worth of
 * competition for the artist's own line. If the open rows come back looking
 * composited, the shortest version of it - one camera, one light - goes in,
 * and nothing else does. (*) Mine. */
/* AND THE COUNT IS THE CLAUSE THAT CANNOT GO - Babe, 2026-10-27, on the
 * run before the one that worked: "i did do a test before it which added two
 * character to the scene, so i did have to prompt add a single character to
 * the scene". The long version opens "several panels of the SAME person" and
 * the first short draft said only "the person from image 1", which is a
 * singular noun in front of a picture holding four figures - and this rail's
 * oldest lesson is that a reference nobody has given a job to gets averaged.
 * Four panels is four people until something says otherwise, so the count is
 * said twice now, once about the photograph and once about the sheet, and it
 * is still a shorter sentence than the paragraph it replaced. */
/* AND THE TWO PICTURES ARE NAMED BY THE ENCODER THAT READS THEM, the way
 * `SHEET_LINE` and `STYLE_SYS` take theirs. qwen's encoder reads image_1 and
 * image_2 and is happy with the words; Klein's reads <ref_image_0> and
 * <ref_image_1> and says so in its own node description. The addresses and
 * the words describing them cannot be allowed to disagree, which is the
 * whole reason this string takes them. */
const PLACE_LINE = (lens, hasPlace, one = "Image 1", two = "image 2") =>
  "One photograph of one person, not a grid or a contact sheet. " + one + " is "
  + "several panels of that same person - take their face, hair and costume, "
  + "never its panels, flat light or plain "
  + (hasPlace
      ? `ground. They stand in the place in ${two}, lit only by its own light. `
      : "ground. They are in the place described below, lit only by its own light. ")
  + (lens ? `Shot on ${String(lens).toLowerCase()}. ` : "")
  + "Their frame:";

const PLACE_SYS = (lens, hasPlace) =>
  "You are placing an established character into an environment. "
  + "Image 1 is that character's reference sheet: several panels of the same "
  + "person. Read the person off it - the face, the hair, the build, the "
  + "costume and everything they wear or carry - and keep all of it exactly. "
  + "Ignore the sheet as a picture: its panels, its framing, its flat lighting "
  + "and its plain ground belong to the sheet and not to this. "
  + (hasPlace
      ? "Image 2 is the environment. Keep it as it is - the same architecture, "
        + "surfaces, weather, time of day and light - and put the character "
        + "into it, standing where a person would stand. If anyone is already "
        + "in image 2 they are not part of it; your character takes their "
        + "place. The words say how to frame it. "
      : "The environment is described in words below; build it. ")
  + "Return ONE photograph of that character in that environment: a single "
  + "frame, edge to edge, with no panels, no grid, no split screen, no inset "
  + "and no border. "
  + "THE CHARACTER IS PHOTOGRAPHED IN THE ENVIRONMENT, NOT PLACED ON TOP OF "
  + "IT. One camera took the whole frame, so they are seen from the same "
  + "height, the same angle and the same distance as everything around them; "
  + "their verticals agree with its verticals, they stand on its floor rather "
  + "than in front of it, and they are the size a person standing there would "
  + "be. "
  + "Every bit of their light comes from the environment's own sources - its "
  + "lamps, windows, sky and reflections - arriving from the same direction "
  + "and at the same colour, hardness and brightness as the light on "
  + "everything else, with bounce from the surfaces nearest them. They cast "
  + "the shadow that light would cast, onto the floor and onto whatever they "
  + "are near, and they take the same haze, depth of field, grain, contrast "
  + "and colour grade as the rest of the frame. "
  + "No light source that is not in the environment, no rim or key invented "
  + "to separate them from it, no clean cut edge, nothing that reads as "
  + "pasted or composited. "
  + (lens ? `Shot on ${String(lens).toLowerCase()}. ` : "")
  /* THE ARTIST GETS THE LAST WORD, AND THIS LINE WAS TAKING IT BACK. A flat
   * "photographic" at the end of the scaffolding contradicts anyone who asks
   * for a game render, an illustration or a film stock - the agent can name
   * the medium perfectly and still be overruled one sentence later by the
   * server. Photographic is the default for this rung, not a rule. */
  + "Photographic, unless the words below call for another medium or style - "
  + "then that is what it is, and everything above about the camera, the "
  + "light and the shadows is true of it in that medium. "
  + "In focus, no text and no watermark.";

/* 05's scaffolding, which is a function of which face the artist is sending.
 * The swap itself never changes; what changes is whether the reference is
 * allowed to be the look. */
const SWAP_SYS = (fromShot) =>
  "Replace the performer in the driving clip with the character from the "
  + "reference, holding the wardrobe, face and build of the reference. Keep the "
  + "timing, the camera, the room and the hands of the driving clip exactly. "
  + (fromShot
      ? "The reference is a finished frame of that character already shot in a "
        + "place: take its grade, its colour and the direction and quality of its "
        + "light as the look of the whole clip."
      : "The reference is a character sheet: several panels of ONE person, lit "
        + "flat on plain neutral ground so the character can be read off it. "
        + "There is one of them in the shot. Take the character only. Its grey "
        + "ground, its flat key and its lack of grade are the sheet's, not the "
        + "shot's - light and grade the result like the driving clip's own room.");

/* 05 WAS RUNNING THE WRONG MODE, NOT THE WRONG MODEL, AND THE NODE SAYS SO
 * IN ONE LINE. `ByteDance2ReferenceNodeV2.model.task_type`:
 *   reference - "generate a new video guided by the reference images, videos
 *               and audio"
 *   edit      - "change a connected reference video (add, remove, replace);
 *               the output KEEPS THE SOURCE CLIP'S OWN LENGTH AND ASPECT
 *               RATIO, and the duration and ratio widgets are ignored"
 * Two paid runs went out on `edit` and both came back as the driving clip
 * barely touched - once against 02's sheet, once against 04's frame. That is
 * not a bad swap, it is edit doing its job: Runware's motion-control guide
 * draws the same line, "motion transfer REGENERATES THE SHOT AROUND THE
 * MOVEMENT. It does not keep the source pixels", against an edit that "keeps
 * the source pixels, changing one element in place". Babe, 2026-10-25: "so we
 * are editing the original. the character", "yeah the mode".
 *
 * TWO REFERENCES, AND EACH ONE NAMED. Seedance addresses them in the prompt
 * as @Video1 and @Image1 (Runware), MiniMax H3 as "Video 1" and "Image 1"
 * (RunDiffusion) - so the convention is per model and the scaffolding is per
 * variant, which is what `sys` on a variant has always been for.
 * THE NEGATIVE IS THE PART WE WERE MISSING. Every earlier version of this
 * sentence said keep the motion, the camera and the timing and never said
 * what NOT to keep. H3's own motion-only pattern spells it out - "Do not copy
 * the person, clothing, or studio from <Video 1>" - and Runware warns from
 * the other side that a reference video alone "reinvents the face, product
 * and wardrobe on each run", which is why the character has to arrive as an
 * image. Say both halves or the model picks one.
 * AND THE ROLES ARE RESTATED ON PURPOSE. RunDiffusion's structure defines
 * each reference ("Image 1 defines the woman's face, copper hair, and green
 * jacket") and then assigns it again ("Use Image 1 for identity and clothing,
 * Image 2 for location, Video 1 for motion, camera, pacing, and voice").
 * A reference with no stated job is one the model is free to average into the
 * others - the mistake that cost 04 its first clip.
 * EVERYTHING AFTER THE ROLES IS THE ARTIST'S: opening, action, camera and
 * ending are the line on the panel, not the scaffolding. */

/* SEEDANCE 2.5, which addresses references as @Video1 / @Image1. */
const MOTION_SYS = (mode, hasPlace) => {
  /* SWAP AND RECAST ARE NOT THE SAME JOB, and the difference is what happens
     to the footage. Babe, 2026-10-25, on SCAIL-2's character-replacement
     split screen: "we could have a swap mode too for stuff like this".
     RECAST regenerates the shot around the movement - a new frame, your
     character, optionally somewhere else. SWAP leaves the clip standing and
     changes who is in it: the room, the light and the grade are the source's
     and only the person is yours. That is SCAIL-2's entire job, which is why
     that row runs this mode and no other.
     ON SEEDANCE IT IS `edit` WITH A REPLACE INSTRUCTION, because edit keeps
     the source pixels and the node's own words for it are "add, remove,
     replace". Two jobs can share a task type; the mode is the job and the
     task type is the machine, which is what `modes` has always been for. */
  if (mode === "SWAP")
    return "Replace the performer in @Video1 with the character in @Image1, "
      + "holding their face, build and wardrobe exactly. Keep everything else "
      + "in @Video1 as it is: the same room, the same framing, the same camera "
      + "path, the same light and grade, the same timing. Change the person "
      + "and nothing else.";
  if (mode === "EDIT")
    return "Change only what is asked for in @Video1 and keep everything else "
      + "in it exactly as it is - the same performer, the same framing, the "
      + "same room, the same light and the same timing. Use @Image1 for the "
      + "element being changed.";
  if (mode === "EXTEND")
    return "Continue @Video1 forward from its last frame, holding the same "
      + "character, wardrobe, room, light, lens and pace, so the new footage "
      + "cuts to the end of it invisibly.";
  return "@Image1 defines the character - ONE person, and if it is several "
    + "panels they are all that same person: their face, hair, build and "
    + "wardrobe. "
    + (hasPlace
        ? "@Image2 defines the setting and the look: the place, its grade, "
          + "and the direction and quality of its light. "
        : "")
    + "@Video1 provides the motion, the camera path, the framing and the "
    + "pacing. Transfer the exact movement and timing from @Video1 onto the "
    + "character in @Image1, preserving their identity and clothing. "
    /* AND WHAT IS IN THEIR HANDS IS THE FOURTH THING TO REFUSE. Babe,
       2026-10-27, holding a computer mouse up to their mouth: "trying to
       figure out how to make my mouse look like a breathing mouthpiece. it
       sohuld be possible." It is - but the negative named the performer, the
       clothing and the room, and a prop is none of the three, so nothing told
       the model to let the mouse go while the sentence above it asked for the
       gesture EXACTLY. The direction says what the hand holds; the video only
       says how the hand moves. Say both halves or the model picks one. */
    + "Do not copy the performer, the clothing, the objects in their hands or "
    + "the " + (hasPlace ? "location" : "studio") + " from @Video1. @Video1 "
    + "supplies the gesture, never the thing being held: if the direction "
    + "names what is in their hands, render that and not what the video shows "
    + "there.";
};

/* MINIMAX H3, which addresses references as "Image 1" / "Video 1" in
 * connection order, and whose guide asks for the roles twice. */
const H3_SYS = (hasPlace) =>
  "Image 1 defines the character: their face, hair, build and wardrobe. "
  + (hasPlace
      ? "Image 2 defines the location and the light: the place, its grade, "
        + "and the direction and quality of its lighting. "
      : "")
  + "Video 1 provides the motion, the camera behaviour, the pacing and the "
  + "timing. Use Image 1 for identity and clothing, "
  + (hasPlace ? "Image 2 for location, " : "")
  + "and Video 1 for motion, camera and pacing. Transfer the movement and "
  + "timing from Video 1 to the character in Image 1 while preserving their "
  + "identity and clothing. Do not copy the person, the clothing or the "
  + (hasPlace ? "location" : "studio") + " from Video 1.";

/* THE SAME THREE ROLES, IN THE OPEN NODE'S TAGS. H3_SYS above is written for
 * the partner node, which reads its references as "Image 1" and "Video 1" in
 * connection order; the open `ref2va` weights read `<Picture 1>` and
 * `<Video 1>` and say so in the node's own description. One sentence cannot
 * serve both, which is the rule this rail already keeps per model.
 *
 * AND THE NEGATIVE IS THE HALF THAT PROVED ITSELF. Two paid runs in `edit`
 * came back as the driving studio barely touched; the one run that worked
 * said, in as many words, do not copy the performer, the clothing or the
 * location from the video. Both guides Babe brought say the same thing from
 * opposite sides. Say both halves or the model picks one. */
const H3_R2V_MOVE_SYS = (hasPlace) =>
  "<Picture 1> defines the character: their face, hair, build and wardrobe. "
  + (hasPlace
      ? "<Picture 2> defines the location and the light: the place, its "
        + "grade, and the direction and quality of its lighting. "
      : "")
  + "<Video 1> provides the motion, the camera behaviour, the pacing and the "
  + "timing. Use <Picture 1> for identity and clothing, "
  + (hasPlace ? "<Picture 2> for location, " : "")
  + "and <Video 1> for motion, camera and pacing. Transfer the movement and "
  + "timing from <Video 1> to the character in <Picture 1> while preserving "
  + "their identity and clothing. Do not copy the person, the clothing, the "
  + "objects in their hands or the "
  + (hasPlace ? "location" : "studio") + " from <Video 1>. <Video 1> supplies "
  + "the gesture, never the thing being held: if the direction names what is "
  + "in their hands, render that and not what the video shows there. "
  + "Give the clip its own sound to match what you have made.";

/* HIGGSFIELD GENJUTSU - built and wired, not on the row today. Same two
 * references, no mode axis, and billed per output second at 205.5
 * credits/second, which is about 1,240 credits on a six-second clip. */
const GENJUTSU_SYS = (hasPlace) =>
  "Recast the performer in the source video as the character in the "
  + (hasPlace ? "first reference image" : "reference image")
  + ", holding their face, build and wardrobe exactly. "
  + (hasPlace
      ? "Use the second reference image as the setting and the look. "
      : "")
  + "Keep the source motion, camera movement, timing and audio, and do not "
  + "keep its performer, their clothing, the objects in their hands or its "
  + "room. The source supplies the gesture, never the thing being held.";

/* 01's STYLE SENTENCE, AND IT HAS TO KNOW WHETHER THERE IS A REFERENCE -
 * Babe, 2026-10-27, on a words-only STYLE run coming back as the photograph
 * it was handed: "idk if its applying my prompt". Measured in the dry run:
 * the second loader had dropped and the sentence still read "in the style of
 * image 2" and "take from image 2 only its style", naming a picture that was
 * not in the payload. That is both of this rung's own lessons at once - a
 * reference with no stated job gets averaged, and a reference that is not
 * there at all leaves a sentence whose every surviving clause says KEEP.
 * A PRESERVATION-HEAVY PROMPT UNDER-EDITS, which this file has said since the
 * first real run here, and the correct answer to "keep the framing, the pose,
 * the expression and the face, and take the style from a picture that does
 * not exist" is the photograph back.
 * SO THE WORDS ARE THE STYLE WHEN THERE IS NO SECOND PICTURE. With a
 * reference the style comes from image 2 and the artist's line refines it;
 * without one the sentence says the description IS the style and that all of
 * it changes - the same paragraph swap PLACE_SYS makes on 03 for the same
 * reason.
 * ONE FUNCTION FOR BOTH QWEN ROWS, because they are one encoder: the same
 * TextEncodeQwenImage21 with the same image_1/image_2 vocabulary. The two
 * strings it replaces had drifted into a long one and a short one describing
 * one job, which is this repo's most expensive shape. */
/* AND THE TWO HALVES ARE NOT THE SAME SHAPE OF SENTENCE - Babe, 2026-10-27,
 * on a qwen-edit STYLE run that came back as the photograph with a grade on
 * it: "yeah not combining it with the style.. hm".
 * BOTH HALVES HAD IT, and calling the reference branch proven was wrong: the
 * open-weights sweep records this row on 01 as "19.0s" and nothing about
 * what came back, so what is proven is that it RUNS. Babe, with a scientist
 * reference in the slot: "still getting just an image of me looking older
 * not really having the clothing of the scientist reference".
 * WITHOUT ONE THE STYLE IS THE ARTIST'S LINE, and on these rows that line is
 * JOINED TO THE END of all this - qwen has no system_prompt input, so the
 * scaffolding is prefix, not a separate channel. Ninety words of KEEP in
 * front of five words of costume is a text encoder being told mostly to
 * preserve, and PRESERVATION LOCKS CONTENT, NEVER EDIT STRENGTH - the
 * failure this rung's first real run already paid for, arriving by the other
 * route.
 * AND THEN THE GRAPH ANSWERED IT. Babe, on the third try: "it made me look
 * even older ha" - same t-shirt, same red chair, same wall, grey hair.
 * `qwen-image-21-edit.json` runs at CFG 1 with an EmptyLatentImage and
 * denoise 1, so nothing is wrong with the wiring - and the prompt the
 * template SHIPS on that node is four words: "Replace costumes for the
 * character". At CFG 1 there is no classifier-free guidance, so the
 * conditioning is all the steering there is, and seventy words of ours
 * against four of theirs is the whole difference between the demo
 * transferring a denim shirt and this returning a portrait with a grade on
 * it. A long instruction does not steer this model harder, it spreads it.
 * SO THE QWEN SCAFFOLDING IS SHORT NOW, in the template's own register: the
 * operation, the one thing to keep, and out. Every clause removed was a true
 * sentence competing with the artist's line for the same attention. The
 * detailed version is right for nano, which reads it as a system prompt in
 * its own input and is an instruction-follower; it was never right here. */
/* SO THE SHORT BRANCH LEADS WITH THE OPERATION, keeps the preservation to
 * the one thing that actually has to survive, and ENDS ON A COLON so the
 * line the server appends reads as what is being made rather than as an
 * afterthought. */
const STYLE_SYS = (hasRef, one = "image 1", two = "image 2") =>
  hasRef
    ? `Restyle the person in ${one} as the character in ${two} - its costume, ` +
      `hair, props, lighting and style. Keep ${one}'s face and the exact same ` +
      `pose and facial expression.`
    : `Restyle the person in ${one} as a new character. Keep their face and the ` +
      `exact same pose and facial expression:`;

const RUNGS = {
  /* THE PLACE. Same graphs as 01 and 02 with one reference: the sheet goes in
   * 470 and 475 comes out, because there is no second image here - the place
   * arrives as words. Nano leads as it does on the rungs either side. */
  3: {
    graph: "nano-banana-21-edit.json",
    model: "NANO-BANANA-2.1",
    label: "Find your place",
    traits: "note",
    /* THE PLACE CAN BE A PICTURE. 475 is the same second loader 01 uses for
     * its style reference; here it holds the room. It still drops when the
     * place arrives as words alone, which is the other half of the slot. */
    sys: (v) => PLACE_SYS(v.lens, !!v.place),
    inputs: {
      sheet: { node: "470", input: "image" },
      place: { node: "475", input: "image" },
      prompt: { node: "500", input: "prompt" },
      sys: { node: "500", input: "system_prompt" },
      ar: { node: "500", input: "model.aspect_ratio" },
      res: { node: "500", input: "model.resolution" },
      seed: { node: "500", input: "seed", cast: Number },
    },
    required: ["sheet", "prompt"],
    dropWhenEmpty: { place: ["475"] },
    defaults: { ar: "16:9", res: "2K" },
    /* the place is the whole instruction on this rung, so an empty line still
     * has to describe somewhere to stand. */
    blankTo: { prompt: "Put this character somewhere that suits them." },
    params: ["ar", "seed", "lens"],
    variants: {
      "QWEN-IMAGE-EDIT-21": {
        graph: "qwen-image-21-edit.json",
        label: "Find your place",
        sys: (v) => PLACE_LINE(v.lens, !!v.place),
        inputs: {
          sheet: { node: "470", input: "image" },
          place: { node: "475", input: "image" },
          prompt: { node: "459:474", input: "prompt" },
          width: { node: "459:456", input: "width", cast: Number },
          height: { node: "459:456", input: "height", cast: Number },
          steps: { node: "459:458", input: "steps", cast: Number },
          seed: { node: "459:458", input: "seed", cast: Number },
        },
        required: ["sheet", "prompt"],
        dropWhenEmpty: { place: ["475"] },
        defaults: { steps: 25 },
        /* AND STEPS IS ON THIS ROW NOW, which it was not when the open rows
         * first ran here: it is the one quality knob they have, the same
         * cell 02 grew for the same reason, and it was running the graph's
         * own 25 with no way to see that let alone move it. */
        params: ["ar", "seed", "steps", "lens"],
      },
      "QWEN-IMAGE-21-TURBO": {
        graph: "qwen-image-21-turbo.json",
        label: "Find your place",
        sys: (v) => PLACE_LINE(v.lens, !!v.place),
        /* AR DOES NOTHING HERE: this graph samples the latent the encoder
         * derives from the input, so the frame comes back the shape of the
         * sheet - which on this rung means a 16:9 sheet gives a 16:9 frame
         * by accident rather than by asking. */
        inputs: {
          sheet: { node: "470", input: "image" },
          place: { node: "475", input: "image" },
          prompt: { node: "459:474", input: "prompt" },
          steps: { node: "459:458", input: "steps", cast: Number },
          seed: { node: "459:458", input: "seed", cast: Number },
        },
        required: ["sheet", "prompt"],
        dropWhenEmpty: { place: ["475"] },
        defaults: { steps: 8 },
        params: ["seed", "steps", "lens"],
      },
      /* AND FLUX.3 KLEIN TAKES TWO REFERENCES, WHICH IS THIS RUNG'S OWN
       * SHAPE - Babe, 2026-10-29: "yeah lets do 3 with qwen and add flux 3
       * klein that one as well". 01 hands this graph a face and a style
       * donor and 02 hands it a page and a figure; here it is the sheet and
       * the room, and nothing about the wiring is rung-specific, so it is
       * the same two loaders into the same encoder with this rung's names.
       * THE SHEET LEADS, AND THE NODE'S OWN RULE IS WHY - a free read of
       * `ReferenceMultiLatent` says the list may be omitted entirely, but
       * "if you use it, images.image0 must be filled". So the reference
       * that DROPS can never be slot 0, and on this rung the one that drops
       * is the place: the sheet is `required` and the room is the half of
       * the slot that may arrive as words. That settles the order without
       * a run.
       * WHICH MEANS THE FRAME COMES BACK THE SHAPE OF THE SHEET, because
       * this encoder sizes the latent from its first reference - the
       * opposite arrangement from 02, where the page leads for exactly that
       * reason. On Hero, the default, that is the 16:9 this rung defaults
       * to anyway; a Bible sheet would give a portrait frame. No AR cell,
       * as everywhere this row appears.
       * (*) IF A PORTRAIT FRAME EVER READS WRONG, the swap is the place
       * first and `required` with it - and the cost is the words-only half
       * of this slot refusing on this one row, which is why it is written
       * down rather than taken. */
      "FLUX-3-KLEIN": {
        graph: "flux3-klein-2ref.json",
        label: "Find your place",
        sys: (v) => PLACE_LINE(v.lens, !!v.place, "<ref_image_0>", "<ref_image_1>"),
        inputs: {
          sheet: { node: "11", input: "image" },
          place: { node: "12", input: "image" },
          prompt: { node: "100", input: "value" },
          steps: { node: "7", input: "steps", cast: Number },
          seed: { node: "7", input: "seed", cast: Number },
        },
        required: ["sheet", "prompt"],
        /* the second loader goes when nobody filled it and the reference
         * slot on the conditioning node goes with it, so the sentence stops
         * naming <ref_image_1> in the same breath. */
        dropWhenEmpty: { place: ["12"] },
        defaults: { steps: 16 },
        params: ["seed", "steps", "lens"],
      },
    },
  },
  /* NOT A RUNG ON THE RAIL: the AUTO cell on 02's traits card. A text model
   * with eyes, so the nine fields arrive as a draft to correct rather than a
   * form to fill. It is the first thing in this app that reads instead of
   * draws, which is why the job comes back as `text` and not as a file. */
  /* NOT A RUNG ON THE RAIL EITHER: the AGENT face on a writing slot. The
     same node as the traits read, and from 2026-10-26 with the same eyes -
     see AGENT_SEES. `look` is what the rung's left slot is holding.
     IT IS OPTIONAL, AND THE SENTENCE FOLLOWS IT. A rung whose left slot is
     still empty, a page open off disk, a carry that could not be read: the
     loader drops, the paragraph naming the picture goes with it, and the
     agent is the blind one it was yesterday rather than one addressing a
     picture that is not there. */
  agent: {
    graph: "gemini-chat.json",
    model: "GEMINI-3.5-FLASH",
    label: "The agent",
    sys: AGENT_SYS,
    inputs: {
      look: { node: "1", input: "image" },
      prompt: { node: "2", input: "model.prompt" },
      sys: { node: "2", input: "model.system_prompt" },
      seed: { node: "2", input: "model.seed", cast: Number },
    },
    required: ["prompt"],
    dropWhenEmpty: { look: ["1"] },
  },

  traits: {
    graph: "gemini-traits.json",
    model: "GEMINI-3.5-FLASH",
    label: "Read the character",
    sys: TRAITS_SYS,
    inputs: {
      figure: { node: "1", input: "image" },
      prompt: { node: "2", input: "model.prompt" },
      sys: { node: "2", input: "model.system_prompt" },
      seed: { node: "2", input: "model.seed", cast: Number },
    },
    required: ["figure", "prompt"],
  },
  /* Not a rung on the rail: the Random cell in rung 01's style-reference
   * tray. A text-to-image pass so "deal me one" is a real character rather
   * than a stock card that quietly sends nothing. */
  random: {
    graph: "qwen-21-turbo-t2i.json",
    model: "QWEN-IMAGE-21-TURBO",
    label: "Random character",
    inputs: {
      prompt: { node: "452", input: "prompt" },
      ar: { node: "13", input: "aspect_ratio" },
      seed: { node: "488", input: "noise_seed", cast: Number },
    },
    required: ["prompt"],
    defaults: { ar: "2:3 (Portrait Photo)" },
  },
  1: {
    /* THE DEFAULT IS THE PAID ROW, deliberately: this rung has to hold a face
     * and nothing open-weights does it as well yet. The open rows are one
     * click away and the receipt says which side you are on. */
    graph: "nano-banana-21-edit.json",
    label: "Become someone",
    model: "NANO-BANANA-2.1",
    /* nano carries its scaffolding in the graph's own `system_prompt` input
     * rather than in `sys` — which is the point of per-model backends: the
     * instruction goes wherever that model wants it. */
    inputs: {
      source: { node: "470", input: "image" },
      ref: { node: "475", input: "image" },
      prompt: { node: "500", input: "prompt" },
      /* THE ADDRESS EXISTS EVEN WHERE STYLE DOES NOT USE IT. Nano carries
       * this rung's become-someone scaffolding in the graph's own
       * `system_prompt`, so STYLE sends no `sys` and nothing is patched here;
       * EDIT composes a sentence and this is where nano wants it. Declared
       * once, so a mode does not have to re-state the whole input table to
       * add one line to it. */
      sys: { node: "500", input: "system_prompt" },
      ar: { node: "500", input: "model.aspect_ratio" },
      res: { node: "500", input: "model.resolution" },
      seed: { node: "500", input: "seed", cast: Number },
    },
    required: ["source", "prompt"],
    dropWhenEmpty: { ref: ["475"] },
    defaults: { ar: "1:1", res: "2K" },
    /* NOTHING UNLESS THE SOURCE IS THE PRESET. `null` leaves the graph's own
     * system prompt exactly where it is, which is the right instruction for
     * the job this rung is normally doing - a photograph of a person whose
     * face has to survive. `guide` rides in as a value and reaches no node;
     * it only decides whether that instruction is replaced. */
    /* THREE JOBS ON ONE RUNG, AND THE SOURCE SAYS WHICH. A photograph you
     * imported is what the graph's own instruction was written for, so it
     * sends nothing and the graph keeps it. */
    /* AND A SOURCE WITH NO PROVENANCE AND NO REFERENCE CANNOT HAVE THE
     * GRAPH'S OWN SENTENCE EITHER. It opens "You are given two images. Image
     * 1 is the subject. Image 2 is the style", which is the right
     * instruction when there IS an image 2 and describes a picture that is
     * not in the payload when there is not - and every clause still standing
     * after that one says KEEP. A preservation-heavy prompt under-edits,
     * which is this rung's oldest lesson, and the result is the photograph
     * handed back.
     * IT IS CUSTOM_SYS AND NOT A NEW STRING, because "whatever somebody
     * brought, no reference, make the character described below" is exactly
     * what that one already says. A journey written before provenance was
     * recorded is the only way to reach this now. */
    sys: (v) => (v.guide ? GUIDE_SYS(!!v.ref)
               : v.cam ? CAM_SYS(!!v.ref)
               : v.custom ? CUSTOM_SYS(!!v.ref)
               : !v.ref ? CUSTOM_SYS(false)
               : null),
    /* THE STYLE SENTENCE LIVES HERE NOW. It was the page's prompt line until
     * 2026-10-25, when that line became a sub-header with a red word in it -
     * so the words moved to the floor under an empty prompt, which is where
     * 02, 03 and 04 already keep theirs. A STYLE run with a picture and no
     * words still goes out saying this; it just stops being said twice. */
    blankTo: { prompt: "Become the character in the reference." },
    /* which cells in the model row mean anything here. Nano has no step
     * count, so showing STEPS beside it would be a lie. Absent = all. */
    params: ["ar", "seed", "res"],
    /* THE SECOND MODE, AND IT INHERITS ALMOST EVERYTHING. This rung is
     * already shaped like an edit - one picture in 470, an optional second in
     * 475 that drops when nobody filled it, a line the artist wrote - so the
     * mode changes the two things that genuinely differ: what the instruction
     * says, and what the refusal is called when there is no sentence yet. */
    modes: {
      EDIT: {
        label: "Edit the picture",
        sys: (v) => EDIT_SYS(!!v.ref),
        /* AND THE FLOOR DOES NOT REACH THIS MODE. Inheriting it would make
         * an edit with no sentence quietly run the become-someone line
         * instead of refusing - the same silence this mode was built to end.
         * An edit nobody described is nothing to run. */
        blankTo: {},
      },
    },
    variants: {
      "QWEN-IMAGE-EDIT-21": {
        graph: "qwen-image-21-edit.json",
        label: "Become someone",
        /* Qwen's encoder takes the two references as image_1 and image_2, so
         * its prompt has to address them by those names. THE SOURCE IS THE
         * GUIDE, NOT THE REFERENCE: framing, camera angle, pose and
         * expression all come from image 1, so a headshot stays a headshot
         * whatever shape the reference happens to be. */
        sys: (v) => STYLE_SYS(!!v.ref),
        inputs: {
          source: { node: "470", input: "image" },
          ref: { node: "475", input: "image" },
          prompt: { node: "459:474", input: "prompt" },
          /* this graph samples an EmptyLatentImage rather than the latent the
           * encoder derives from the source, which is the only reason AR can
           * mean anything on this rung. */
          width: { node: "459:456", input: "width", cast: Number },
          height: { node: "459:456", input: "height", cast: Number },
          steps: { node: "459:458", input: "steps", cast: Number },
          seed: { node: "459:458", input: "seed", cast: Number },
        },
        required: ["source", "prompt"],
        dropWhenEmpty: { ref: ["475"] },
        defaults: { steps: 25, width: 1024, height: 1024 },
        params: ["ar", "seed", "steps"],
        /* the same two modes here. `sys` is a string on this row and goes in
         * front of what the artist wrote, which is the one difference between
         * the rows and the reason the scaffolding lives beside the graph. */
        modes: {
          EDIT: {
            label: "Edit the picture",
            sys: (v) => EDIT_LINE(!!v.ref),
          },
        },
      },
      "QWEN-IMAGE-21-TURBO": {
        graph: "qwen-image-21-turbo.json",
        label: "Become someone",
        sys: (v) => STYLE_SYS(!!v.ref),
        /* the turbo graph samples the latent the encoder derives from the
         * source, so it has no width/height to set and its output follows
         * the shape of the photo you put in. */
        inputs: {
          source: { node: "470", input: "image" },
          ref: { node: "475", input: "image" },
          prompt: { node: "459:474", input: "prompt" },
          steps: { node: "459:458", input: "steps", cast: Number },
          seed: { node: "459:458", input: "seed", cast: Number },
        },
        required: ["source", "prompt"],
        dropWhenEmpty: { ref: ["475"] },
        defaults: { steps: 8 },
        /* no empty latent, so the output follows the source and AR does
         * nothing — the cell is hidden rather than ignored. */
        params: ["seed", "steps"],
        /* the same two modes here. `sys` is a string on this row and goes in
         * front of what the artist wrote, which is the one difference between
         * the rows and the reason the scaffolding lives beside the graph. */
        modes: {
          EDIT: {
            label: "Edit the picture",
            sys: (v) => EDIT_LINE(!!v.ref),
          },
        },
      },
      /* FLUX 3 IMAGE KLEIN, THE DISTILLED OPEN WEIGHTS - Babe, 2026-10-27:
       * "i wonder if we should add flux 3 edit". The name has been sitting on
       * 01's picker greyed out since the row was first considered, on this
       * file's own note that `image_flux3_klein_image_edit` takes ONE input
       * image and is therefore not a drop-in where a source and a reference
       * are both needed.
       *
       * THAT NOTE WAS ABOUT THE TEMPLATE'S WIRING, NOT THE MODEL. The graph's
       * own group is titled "Plug more reference images here" and
       * `ReferenceMultiLatent` takes `images.image0` and `images.image1`,
       * addressed in the prompt as <ref_image_0> and <ref_image_1>. So it
       * does both of this rung's jobs: a style donor on STYLE and the thing
       * an instruction refers to on EDIT. Checked before building, which is
       * the only reason this row exists.
       *
       * AND THE PROMPT UPSAMPLER IS DELIBERATELY NOT HERE. The template runs
       * the artist's line through a 9B `TextGenerate` that rewrites it into a
       * caption before the model sees it - a second director talking over the
       * first, which this rail has paid for on three rungs. It is also what
       * the ComfySwitchNode is attached to, and a switch in front of a prompt
       * is the trap that returned demo art on the turbo row. Both are gone:
       * the sentence this server composes is the sentence that is encoded.
       *
       * NO AR CELL. There is no EmptyLatentImage - `ReferenceMultiLatent`
       * hands the sampler an empty latent sized from the reference - so the
       * output follows the shape of what you put in, exactly as on the turbo
       * row above, and a control that does nothing is worse than no control.
       * 16 steps and cfg 1 are the distilled checkpoint's own numbers. */
      /* IT WAS THE EDIT ROW AND NOTHING ELSE, AND THE PIN CAME OFF
       * 2026-10-29. It went on 2026-10-27 after one STYLE run came back as
       * the photograph it was given - Babe: "i dont think edit is the right
       * workflow for this. maybe it should only appear when you are in the
       * edit tab" - and the argument written down beside it was that
       * `ReferenceMultiLatent` sizes the latent from the reference, so a
       * preservation-heavy become-someone sentence over a photograph of you
       * is a job whose correct answer is that photograph.
       * THREE THINGS SAY OTHERWISE, AND THE FIRST IS THE MODEL'S OWN PAGE.
       * BFL ships Klein as "generation, editing and multi-reference in a
       * single set of weights", it "combines several references into one
       * image", and restyling is a named use - which is STYLE's whole job in
       * Babe's own words: "so we want style to be model where you combine
       * two images".
       * AND THE LATENT ARGUMENT PROVES TOO MUCH: QWEN-IMAGE-21-TURBO samples
       * the latent the encoder derives from the source in exactly the same
       * way, and it ran STYLE clean in 23.3s - a true 1024 square with the
       * head-and-shoulders crop held. A row cannot be refused for a property
       * the row above it shares and works with.
       * SO THE SUSPECT WAS THE SENTENCE, WHICH IS THIS RUNG'S OWN LESSON.
       * The open rows were never short of ability, they were being talked
       * over: the same STYLE line that came back photographic on qwen
       * produced a real restyle once it was cut to the encoder's register.
       * That cut is what `STYLE_SYS` is now, and this row never had it - the
       * base sentence was deleted when the pin went on, so what goes back is
       * the short one rather than the long one that failed.
       * (*) UNPROVEN ON SCREEN. If STYLE here hands back the photograph with
       * the short sentence in front of it, the pin was right for a reason
       * nobody has named yet and this comment is the thing to correct. */
      "FLUX-3-KLEIN": {
        graph: "flux3-klein-2ref.json",
        label: "Become someone",
        /* addressed by the encoder's own token names, the way qwen's is
         * addressed as image_1 and image_2 - `modes.EDIT` below overrides
         * this with the edit line and passes the same two names. */
        sys: (v) => STYLE_SYS(!!v.ref, "<ref_image_0>", "<ref_image_1>"),
        inputs: {
          source: { node: "11", input: "image" },
          ref: { node: "12", input: "image" },
          prompt: { node: "100", input: "value" },
          steps: { node: "7", input: "steps", cast: Number },
          seed: { node: "7", input: "seed", cast: Number },
        },
        required: ["source", "prompt"],
        /* the second loader goes when nobody filled it, and the reference
         * slot on the conditioning node goes with it - so the sentence stops
         * naming <ref_image_1> in the same breath, because `sys` reads the
         * values the drops were taken out of. */
        dropWhenEmpty: { ref: ["12"] },
        defaults: { steps: 16 },
        params: ["seed", "steps"],
        modes: {
          EDIT: {
            label: "Edit the picture",
            sys: (v) => EDIT_LINE(!!v.ref, "<ref_image_0>", "<ref_image_1>"),
          },
        },
      },
      /* MAGE-FLOW-EDIT TURBO, THE OTHER KIND OF OPEN ROW - Babe, 2026-10-27:
       * "then we need to remove the ones that are not edit models. and add
       * the ones that are". Four names on this picker had no graph behind
       * them and came off; this is the one that went on in their place.
       * IT IS AN INSTRUCTION-BASED EDITOR AND NOTHING ELSE, which is why it
       * is here rather than on the STYLE tab: Microsoft's 4B Mage-Flow-Edit,
       * distilled to FOUR STEPS, built for background replacement, local
       * changes, relighting and restoration. Every other row on this rung is
       * a general image model asked to edit; this one was trained to.
       * THE GRAPH IS THE TEMPLATE'S SUBGRAPH FLATTENED AND STRIPPED. The
       * template wraps everything in one node and spends nine of its twenty
       * on a resize branch - two ComfySwitchNodes, a GetImageSize and four
       * primitives - which exists so the UI can offer a manual output size.
       * We do not: `width`/`height` stay 0, which the node's own doc says
       * means take the first reference's size, so the output follows the
       * photograph exactly as it does on the turbo and FLUX rows above.
       * AND THAT IS ALSO WHY THERE IS NO AR CELL. Mage needs both sides a
       * multiple of SIXTEEN and `arSize` rounds to eight, so a ratio asked
       * for here would have been a number the model has to correct - and a
       * control that does nothing is worse than no control.
       * NO STEPS CELL EITHER: the turbo checkpoint is distilled to 4 and the
       * row's options start at 8, so every one of them would be a way of
       * making it worse.
       * (*) IF THE FIRST ROLL COMES BACK AS FLAT TEXTURE rather than a
       * picture, the suspect is the int8_convrot unet, which is exactly how
       * the qwen turbo row failed; `mage_flow_edit_turbo_bf16.safetensors`
       * is the one-line swap and the text encoder stays where it is. */
      "MAGE-FLOW-EDIT": {
        graph: "mage-flow-edit-turbo.json",
        label: "Become someone",
        only: "EDIT",
        inputs: {
          source: { node: "11", input: "image" },
          ref: { node: "12", input: "image" },
          prompt: { node: "5", input: "prompt" },
          seed: { node: "6", input: "seed", cast: Number },
        },
        required: ["source", "prompt"],
        /* the second loader goes when nobody filled it, and the encoder's
         * own `images.image_2` goes with it - the prune reads the graph, so
         * the sentence and the wiring cannot disagree about how many
         * pictures there are. */
        dropWhenEmpty: { ref: ["12"] },
        params: ["seed"],
        modes: {
          EDIT: {
            label: "Edit the picture",
            sys: (v) => EDIT_LINE(!!v.ref),
          },
        },
      },
    },
  },
  /* THE SHEET. Same graphs as 01 and the same two references, but a different
   * pair: 470 holds the figure to keep and 475 holds the layout template the
   * page draws from whichever preset was picked. So the second slot is not
   * missing here — it is the page itself, and 475 only drops when a row
   * somehow arrives without one. */
  /* NANO LEADS THIS RUNG TOO. A sheet is a layout job before it is a
   * rendering job - nine panels that have to agree about one face - and that
   * is the thing nano is unusually good at. The open rows are one click away.
   * No AR cell on any of them: the sheet picker decides the shape of the page,
   * because a 3x3 that stands up and a row of four that lies down are not the
   * same picture at a different ratio. */
  2: {
    graph: "nano-banana-21-edit.json",
    model: "NANO-BANANA-2.1",
    label: "Take shape",
    /* THE RUNG THAT MAKES THE BIBLE IS THE RUNG THAT FILES IT. `keep` writes
     * the five fields beside the sheet they describe and tells this model
     * nothing: 02's own sentence already carries the one trait a picture can
     * show, and five copies of one fact is five things that can disagree. */
    traits: "keep",
    /* THE LAYOUT TEMPLATE IS THE SECOND REFERENCE, and 475 is the loader 01
     * uses for its style donor. The page rasterises whichever sheet was
     * picked and uploads it, so this rung has two images like 01 does - the
     * figure to hold and the page to fill. It is `dropWhenEmpty` rather than
     * `drop` so a row that somehow arrives without one still runs as the
     * one-reference job it was before, instead of failing on a dangling
     * node reference. */
    sys: SHEET_SYS,
    inputs: {
      figure: { node: "470", input: "image" },
      template: { node: "475", input: "image" },
      prompt: { node: "500", input: "prompt" },
      sys: { node: "500", input: "system_prompt" },
      ar: { node: "500", input: "model.aspect_ratio" },
      res: { node: "500", input: "model.resolution" },
      seed: { node: "500", input: "seed", cast: Number },
    },
    required: ["figure", "prompt"],
    dropWhenEmpty: { template: ["475"] },
    defaults: { ar: "16:9", res: "2K" },
    /* the open rows get the sheet instruction glued to the front of whatever
     * was written, so a cleared line still leaves them a prompt. This row's
     * goes to `system_prompt`, so it needs its own floor. */
    blankTo: { prompt: "A character reference sheet of this character." },
    params: ["seed"],
    variants: {
      "QWEN-IMAGE-EDIT-21": {
        graph: "qwen-image-21-edit.json",
        label: "Take shape",
        sys: () => SHEET_LINE(),
        /* qwen's encoder takes the two references as image_1 and image_2, and
         * SHEET_SYS addresses them in those terms, so the template rides the
         * same slot here as it does on nano. */
        inputs: {
          figure: { node: "470", input: "image" },
          template: { node: "475", input: "image" },
          prompt: { node: "459:474", input: "prompt" },
          width: { node: "459:456", input: "width", cast: Number },
          height: { node: "459:456", input: "height", cast: Number },
          steps: { node: "459:458", input: "steps", cast: Number },
          seed: { node: "459:458", input: "seed", cast: Number },
        },
        required: ["figure", "prompt"],
        dropWhenEmpty: { template: ["475"] },
        defaults: { steps: 25 },
        params: ["seed", "steps"],
      },
      "QWEN-IMAGE-21-TURBO": {
        graph: "qwen-image-21-turbo.json",
        label: "Take shape",
        sys: () => SHEET_LINE(),
        /* AR DOES NOTHING ON THIS ROW. The turbo graph samples the latent the
         * encoder derives from the figure, so the sheet comes back the shape
         * of the figure — a square photograph gives a square sheet, which is
         * a cramped place to put four full-length views. */
        inputs: {
          figure: { node: "470", input: "image" },
          template: { node: "475", input: "image" },
          prompt: { node: "459:474", input: "prompt" },
          steps: { node: "459:458", input: "steps", cast: Number },
          seed: { node: "459:458", input: "seed", cast: Number },
        },
        required: ["figure", "prompt"],
        dropWhenEmpty: { template: ["475"] },
        defaults: { steps: 8 },
        params: ["seed", "steps"],
      },
      /* AND FLUX.3 KLEIN DOES THIS JOB TOO - Babe, 2026-10-29, on putting
       * the open rows back here: "not sure if flux can also do that".
       * IT CAN, AND IT IS BETTER SUITED TO IT THAN THE ROW ABOVE. A contact
       * sheet is a STRUCTURED LAYOUT, and Klein is the one model on this
       * rail that was trained on them: BFL's own upsampler prompt names
       * "tables, grids, calendars, keyboards, charts, maps, posters, pages"
       * as things that decompose into regions with a box each. Everything
       * else here is a general image model asked to fill a page.
       * THE WIRING IS 01's GRAPH WITH 02's NAMES. `ReferenceMultiLatent`
       * takes two references and nothing about them is rung-specific, so
       * the figure is `image0` and the template is `image1` - the same two
       * loaders, addressed by the names this rung uses.
       * (*) THE BOX TABLE IS THE UNSPENT IDEA HERE. 02 already knows every
       * panel's rectangle - `SHEETS` is a table of fractions, which is what
       * `cellOf` and `sheetTemplate` both read - so the layout could go as
       * coordinates rather than as a drawn page and a sentence describing
       * it. That would make the template image unnecessary on this row and
       * is the one thing that might finally stop a model painting the
       * gutters. It needs a run, not a rewrite. */
      "FLUX-3-KLEIN": {
        graph: "flux3-klein-2ref.json",
        label: "Take shape",
        /* THE PAGE IS THE FIRST REFERENCE HERE, AND THAT IS THE WHOLE
         * DIFFERENCE FROM 01 - Babe, 2026-10-29: "we'll need to prob base
         * the flux workflow off the sheet as the source".
         * `ReferenceMultiLatent` SIZES THE LATENT FROM THE FIRST REFERENCE,
         * which is why this row has no AR cell anywhere it appears. On 01
         * that means a character comes back the shape of the photograph,
         * which is right. Here it meant a CONTACT SHEET came back the shape
         * of a head-and-shoulders portrait - a square page for four
         * full-length views, which is the one thing a sheet cannot afford.
         * SO THE TEMPLATE LEADS AND THE FIGURE FOLLOWS. The page is already
         * drawn at the preset's own ratio - 16:9 for Hero, 9:16 for Bible -
         * so the output takes the shape the preset decided, and the rung's
         * own rule that THE PRESET OWNS THE RATIO is finally true on this
         * row too rather than only on the rows with an EmptyLatentImage.
         * AND THE SENTENCE SWAPS WITH IT. `SHEET_LINE` names which picture
         * is which, so the two arguments go round the other way - the
         * addresses and the words describing them cannot be allowed to
         * disagree, which is the whole reason that string takes them. */
        sys: () => SHEET_LINE("<ref_image_1>", "<ref_image_0>"),
        inputs: {
          template: { node: "11", input: "image" },
          figure: { node: "12", input: "image" },
          prompt: { node: "100", input: "value" },
          steps: { node: "7", input: "steps", cast: Number },
          seed: { node: "7", input: "seed", cast: Number },
        },
        /* AND THE PAGE IS REQUIRED ON THIS ROW, which it is nowhere else.
         * Everywhere else the template is `dropWhenEmpty` and the job falls
         * back to a words-only sheet; here it is the latent, so a run
         * without one has nothing to size itself from and the fallback is
         * not a smaller job, it is a different one. */
        required: ["figure", "template", "prompt"],
        defaults: { steps: 16 },
        params: ["seed", "steps"],
      },
    },
  },
  /* 05 IS SEEDANCE 2.5 IN REFERENCE MODE, AND THE MODE IS ON THE PANEL.
   * The clip is the motion and the pictures are the identity: the driving
   * clip rides `reference_videos.video_1`, the character `image_1` and the
   * place `image_2`.
   * AND THAT CLOSES THE OLDEST OPEN QUESTION ON THIS RUNG - "05 takes a
   * character and a clip through two slots, but the flow says it can draw on
   * the character, the sheet and the place at once; either the left slot
   * carries a bundle or the rule bends." Neither happened: the node takes 30
   * reference images, so CHARACTER is image_1, LOCATION is image_2, both go,
   * and the sentence names which is which instead of averaging them. On this
   * row the pressed face is only which one you are looking at.
   * THE MODE IS THE TASK TYPE, so EDIT stops being a dead end and becomes a
   * job you can reach - Babe, 2026-10-25: "lets keep edit for a potential 6th
   * section... or mode", then "i dont really want to keep adding more
   * sections". Five rungs stay five.
   * `duration` AND `ratio` ARE REAL IN REFERENCE MODE (4-30s) and ignored in
   * edit, which is why DUR reads the clip and sends it: the honest length for
   * a shot built on your performance is your performance's. */
  6: {
    graph: "seedance25-motion.json",
    model: "SEEDANCE-2.5",
    label: "Your own shot",
    traits: "motion",
    sys: (v) => MOTION_SYS(v.mode, !!v.ref2),
    inputs: {
      clip: { node: "1", input: "file" },
      ref1: { node: "2", input: "image" },
      ref2: { node: "3", input: "image" },
      prompt: { node: "4", input: "model.prompt" },
      task: { node: "4", input: "model.task_type" },
      size: { node: "4", input: "model.resolution" },
      duration: { node: "4", input: "model.duration", cast: Number },
      sound: { node: "4", input: "model.generate_audio", cast: (v) => v !== "DROP" && v !== false },
      seed: { node: "4", input: "seed", cast: Number },
    },
    required: ["clip", "ref1", "prompt"],
    /* the place is a second answer, not a required one: without it the recast
     * still holds and the driving clip's own room is what you get. */
    dropWhenEmpty: { ref2: ["3"] },
    defaults: { task: "reference", size: "720p", sound: "KEEP", duration: 6 },
    params: ["size", "seed", "sound"],
    options: { size: ["480p", "720p", "1080p"] },
    /* A MODE ENTRY OVERRIDES WHAT IT NAMES AND INHERITS THE REST, which is
     * why RECAST is not in here: it is the base. */
    modes: {
      /* SWAP is `edit` pointed at the performer: the clip stands and the
       * person changes. One reference is the whole of it - the place is the
       * clip's own, which is the difference from RECAST. */
      SWAP: {
        defaults: { task: "edit", size: "720p", sound: "KEEP" },
        drop: ["3"],
      },
      /* EDIT changes one element of the clip in place and keeps every source
       * pixel around it, so a reference has nothing to be - NEITHER of them,
       * which is what this had half-right. It dropped the place and went on
       * sending the character, and ByteDance refused the whole submission:
       * `failed to validate images`. The node defines this task as "change a
       * connected reference video", and says every task_type but `auto` is
       * validated AT SUBMIT - so an image beside an edit is not a hint it
       * ignores, it is a job it will not accept. Our own first EDIT run
       * proved the other half by accident: it worked, with an empty left
       * slot.
       * AND THE JOB THAT WANTS A CHARACTER IS SWAP - Babe, 2026-10-29: "this
       * is what i want to do... edit the video to make it look like the new
       * character". That is the clip standing and the person changing, which
       * is the mode one tab to the left and the one reference it takes.
       * (*) EXTEND IS THE SAME SHAPE AND UNPROVEN: it also operates on a
       * connected video, and its comment claims the references are what the
       * new piece has to match. Nobody has run it with one. */
      EDIT: {
        defaults: { task: "edit", size: "720p", sound: "KEEP" },
        drop: ["2", "3"],
        required: ["clip", "prompt"],
      },
      /* EXTEND returns ONLY the newly generated segment, not the source clip
       * with more on the end - so DUR is the length of the new piece, and the
       * references are what it has to match. */
      EXTEND: {
        defaults: { task: "extend", size: "720p", sound: "KEEP", duration: 5 },
        drop: ["3"],
        required: ["clip", "prompt"],
      },
    },
    variants: {
  /* MINIMAX H3, which Babe asked for with RunDiffusion's prompt guide in
   * hand. It is the node that guide was written for: up to 9 reference
   * images, 3 reference videos and 3 reference audios, addressed in the
   * prompt by their connection order as "Image 1", "Video 1", "Audio 1".
   * It has a real duration (4-15s) and a real ratio, and `adaptive` takes
   * the shape from the references rather than imposing one.
   * NO SOUND CELL: there is no generate_audio here, so the row hides it
   * rather than offering a switch that reaches nothing. */
  "MINIMAX-H3": {
    graph: "minimax-h3-ref.json",
    model: "MINIMAX-H3",
    label: "Your own shot",
    sys: (v) => H3_SYS(!!v.ref2),
    inputs: {
      clip: { node: "1", input: "file" },
      ref1: { node: "2", input: "image" },
      ref2: { node: "3", input: "image" },
      prompt: { node: "4", input: "model.prompt" },
      size: { node: "4", input: "model.resolution" },
      duration: { node: "4", input: "model.duration", cast: Number },
      seed: { node: "4", input: "seed", cast: Number },
    },
    required: ["clip", "ref1", "prompt"],
    dropWhenEmpty: { ref2: ["3"] },
    /* 768P and 2K are what "MiniMax H3" takes; 480P belongs to H3 Max. */
    defaults: { size: "768P", duration: 6 },
    params: ["size", "seed"],
    /* "MiniMax H3" takes 768P and 2K; 480P belongs to H3 Max. */
    options: { size: ["768P", "2K"] },
  },
  /* MINIMAX H3 ON THE OPEN WEIGHTS, WHICH IS THE ONE THAT MATTERS ON THIS
   * RUNG. 06's only open row is SCAIL-2, and SCAIL-2 can only swap - so the
   * rung that LOOPS, the one every shot after the return is made on, had no
   * open way to do the job it is named for. This is that: the same
   * `ref2va` checkpoint 05 runs, handed a video as well as a picture.
   *
   * THE CLIP ARRIVES AS FRAMES, NOT AS A VIDEO. `ref_videos.ref_video_0` is
   * typed IMAGE, so `LoadVideo` cannot reach it directly; 150 loads and 151
   * is `GetVideoComponents`, the same pair `scail2-swap.json` already uses.
   * Its outputs are (frames, audio, fps) in that order.
   *
   * AND THE PAIRED SOUNDTRACK IS DELIBERATELY NOT WIRED. The node will take
   * one on `ref_video_audios.ref_video_audio_0`, and 151 is handing the audio
   * over for free - but an imported clip with no audio track would then fail
   * a row whose whole job is to work, and H3 writes its own sound anyway.
   * One wire away the day a take's own voice is wanted.
   *
   * IT IS RESHOOT AND NOTHING ELSE, the same way SCAIL-2 is SWAP and nothing
   * else. `reference` is the only task this graph performs: it cannot keep
   * the source pixels, so it cannot be SWAP or EDIT, and it has no notion of
   * carrying past the last frame. The tabs must not promise what the graph
   * has no way to do.
   *
   * NOT ON THE ROW TODAY, for the reason GENJUTSU is not: three rows per rung
   * is the rule, and the third seat is SCAIL-2's because it is the MIT one.
   * Add "MINIMAX-H3-OPEN" to 06's `models` in the slide table and it appears.
   * The honest row to give up for it is the partner H3, which does the same
   * job on the same rung for money. */
  "MINIMAX-H3-OPEN": {
    graph: "minimax-h3-r2v-clip.json",
    model: "MINIMAX-H3-OPEN",
    label: "Your own shot",
    sys: (v) => H3_R2V_MOVE_SYS(!!v.ref2),
    only: "RESHOOT",
    inputs: {
      clip: { node: "150", input: "file" },
      ref1: { node: "137", input: "image" },
      ref2: { node: "139", input: "image" },
      prompt: { node: "138", input: "value" },
      duration: { node: "132", input: "value", cast: Number },
      seed: { node: "129", input: "noise_seed", cast: Number },
    },
    required: ["clip", "ref1", "prompt"],
    dropWhenEmpty: { ref2: ["139"] },
    defaults: { duration: 6 },
    params: ["seed"],
  },
  /* HIGGSFIELD GENJUTSU - wired and dry-run clean, deliberately NOT on the
   * row. Three rows per rung is the rule this rail keeps, and the third seat
   * belongs to SCAIL-2 because it is the only open-weights row on the only
   * rung that still carries that claim. Put it on the row by adding its name
   * to 05's `models` in the slide table and nothing else changes. */
  "GENJUTSU-V1.0": {
    graph: "genjutsu-motion.json",
    model: "GENJUTSU-V1.0",
    label: "Your own shot",
    sys: (v) => GENJUTSU_SYS(!!v.ref2),
    inputs: {
      clip: { node: "1", input: "file" },
      ref1: { node: "2", input: "image" },
      ref2: { node: "3", input: "image" },
      prompt: { node: "4", input: "model.prompt" },
      size: { node: "4", input: "model.resolution" },
      seed: { node: "4", input: "model.seed", cast: Number },
    },
    required: ["clip", "ref1", "prompt"],
    dropWhenEmpty: { ref2: ["3"] },
    defaults: { size: "720p" },
    params: ["size", "seed"],
    options: { size: ["480p", "720p", "1080p"] },
  },
  "SCAIL-2": {
    graph: "scail2-swap.json",
    model: "SCAIL-2",
    label: "Your own shot",
    /* THE ONE REFERENCE IS EITHER A SHEET OR A SHOT, AND THEY ARE NOT THE
     * SAME KIND OF PICTURE. Babe, 2026-10-25: "in the system prompting we
     * definetly want it to lean on the location shot for the look in general,
     * since the character sheet is sort of the untreated / grey version".
     * 02's sheet is lit flat on plain grey ground on purpose - it is a
     * reference FOR a character, not a photograph OF one - so a swap that
     * reads its light as the look hands back a cut-out. 04's frame is the
     * same character already graded, already in a room, already lit by it.
     * So the scaffolding says which one it is holding and what to take from
     * it; the page sends `face` with every run on this rung. */
    sys: (v) => SWAP_SYS(v.face === "location"),
    /* SCAIL-2 REPLACES A PERFORMER AND DOES NOTHING ELSE - SAM3 segments a
     * person out of the driving clip and the reference takes their place, so
     * SWAP is not one of its modes, it is all of them. The tabs still draw;
     * what they cannot do is make this graph recast or extend. */
    only: "SWAP",
    inputs: {
      clip: { node: "155", input: "file" },
      ref1: { node: "30", input: "image" },
      prompt: { node: "213:3", input: "text", also: [{ node: "262:258", input: "text" }] },
      who: { node: "213:191", input: "text", also: [{ node: "262:242", input: "text" }] },
      turbo: { node: "213:172", input: "value", also: [{ node: "262:255", input: "value" }], cast: (v) => v !== false && v !== "false" },
      seed: { node: "213:19", input: "noise_seed", also: [{ node: "262:227", input: "noise_seed" }], cast: Number },
    },
    required: ["clip", "ref1", "prompt"],
    defaults: { who: "person", turbo: true },
    /* SEED IS THE ONLY CELL THIS GRAPH ACTUALLY TAKES. The row was offering
     * SIZE (480p/768p/1080p) and SOUND (KEEP/DROP) and neither reached a
     * node, which is the thing this rail already decided is worse than no
     * control at all. Both are wirable and neither is a guess away:
     *   - size   -> 213:178 / 213:179 (Int Width / Int Height), mirrored on
     *               262:236 / 262:237, the same `also` pairing every other
     *               input on this rung already uses. The graph ships 896x512,
     *               which is not one of the three labels the row offers - so
     *               the options are wrong before the wiring is, and that is a
     *               design decision about what sizes this rung sells, not a
     *               patch. 90.9s was measured at 896x512; 1080p is not that.
     *   - sound  -> 270 CreateVideo takes audio from 215 GetVideoComponents,
     *               so DROP is that link coming out, not a value going in.
     * Both wait for the pass over 05's panel. */
    params: ["seed"],
  },
    },
  },
  /* 04 TAKES THREE REFERENCES AND MAKES A CLIP - Babe, 2026-10-25: "then
   * sending your style (hero frame) along with the character and the board /
   * to the video model". The hero frame is the look and the place, the sheet
   * is who they are from the angles the frame does not show, and the board is
   * the coverage: one framing, six, or a first and a last. The board is made
   * on this rung too, in the DIRECTION panel, before any of this runs.
   * SEEDANCE 2.5 LEADS. It is a partner model on a rung in an open-weights
   * competition, which is a decision still open everywhere else on this rail,
   * but it is the only one here that reaches all three modes. */
  /* 04 IS THE PLAN. One picture to hold and a page to fill - the same two
   * references the sheet rung takes, and the same three models, because it is
   * the same kind of job: a layout problem before it is a rendering one. The
   * page rasterises whichever mode the DIRECTION panel is showing and uploads
   * it, exactly as it does for 02's preset.
   * IT WAS `RUNGS[4].steps.board` UNTIL 2026-10-25 and is a rung of its own
   * now. Nothing about the spec changed in the move. */
  4: {
    /* ITS OWN GRAPH, BECAUSE A THIRD LOADER IS NOT FREE ON A SHARED ONE.
     * `nano-banana-21-edit.json` is 01's, and a node added there would ride
     * into every STYLE and EDIT run as a reference nobody asked for. This is
     * that graph plus node 476 on `model.images.image_3`. */
    graph: "nano-banana-21-board.json",
    model: "NANO-BANANA-2.1",
    label: "The board",
    traits: "note",
    sys: (v) => BOARD_SYS(!!v.sheet, v.light, v.mode === "single", !!v.template),
    inputs: {
      figure: { node: "470", input: "image" },
      template: { node: "475", input: "image" },
      sheet: { node: "476", input: "image" },
      prompt: { node: "500", input: "prompt" },
      sys: { node: "500", input: "system_prompt" },
      ar: { node: "500", input: "model.aspect_ratio" },
      res: { node: "500", input: "model.resolution" },
      seed: { node: "500", input: "seed", cast: Number },
    },
    required: ["figure", "prompt"],
    dropWhenEmpty: { template: ["475"], sheet: ["476"] },
    defaults: { ar: "16:9", res: "2K" },
    blankTo: { prompt: "A shot board of this scene." },
    params: ["seed"],
    /* THE MODE IS THE JOB ON THIS RUNG, and CUSTOM is a different job rather
     * than a different layout: it inherits the graph, the loaders, the row
     * and the defaults, and changes the one thing that genuinely differs,
     * which is what the model is told it is doing. The sheet is still
     * optional, so the sentence is a function of whether one arrived - the
     * same shape `BOARD_SYS` already is. */
    modes: {
      custom: { sys: (v) => FREE_SYS(!!v.sheet) },
    },
    variants: {
      /* THE OPEN ROWS TAKE TWO REFERENCES, SO THEY ARE TOLD ABOUT TWO.
       * `TextEncodeQwenImage21` names image_1 and image_2 and there is no
       * third, so the sheet is simply not in their `inputs` and `sys` is
       * composed without it - the sentence and the graph describing the same
       * job, which is the rule the dry run exists to check. */
      "QWEN-IMAGE-EDIT-21": {
        graph: "qwen-image-21-edit.json",
        label: "The board",
        sys: (v) => BOARD_LINE(v.light, v.mode === "single", !!v.template),
        /* AND THE MODE HAS TO BE RESTATED HERE, because a variant REPLACES
         * the spec outright - the same reason `steps` lands before the model
         * is picked and `traits` is read off the base. Without it a CUSTOM
         * run on this row would still be told it is building a contact
         * sheet, which is a row lying about the job. These two take one
         * reference on this mode, so the sheet paragraph is never theirs. */
        /* AND IT IS WRAPPED, NOT HANDED OVER. Every `sys` is called with the
         * VALUES, so the moment this line took a name of its own the object
         * went in as that name and the prompt opened `[object Object] is the
         * scene`. Caught by the dry run in the same minute it was written,
         * which is the whole of what that flag is for. */
        modes: { custom: { sys: () => FREE_LINE() } },
        inputs: {
          figure: { node: "470", input: "image" },
          template: { node: "475", input: "image" },
          prompt: { node: "459:474", input: "prompt" },
          width: { node: "459:456", input: "width", cast: Number },
          height: { node: "459:456", input: "height", cast: Number },
          steps: { node: "459:458", input: "steps", cast: Number },
          seed: { node: "459:458", input: "seed", cast: Number },
        },
        required: ["figure", "prompt"],
        dropWhenEmpty: { template: ["475"] },
        defaults: { steps: 25 },
        params: ["seed", "steps"],
      },
      "QWEN-IMAGE-21-TURBO": {
        graph: "qwen-image-21-turbo.json",
        label: "The board",
        sys: (v) => BOARD_LINE(v.light, v.mode === "single", !!v.template),
        /* AND THE MODE HAS TO BE RESTATED HERE, because a variant REPLACES
         * the spec outright - the same reason `steps` lands before the model
         * is picked and `traits` is read off the base. Without it a CUSTOM
         * run on this row would still be told it is building a contact
         * sheet, which is a row lying about the job. These two take one
         * reference on this mode, so the sheet paragraph is never theirs. */
        /* AND IT IS WRAPPED, NOT HANDED OVER. Every `sys` is called with the
         * VALUES, so the moment this line took a name of its own the object
         * went in as that name and the prompt opened `[object Object] is the
         * scene`. Caught by the dry run in the same minute it was written,
         * which is the whole of what that flag is for. */
        modes: { custom: { sys: () => FREE_LINE() } },
        inputs: {
          figure: { node: "470", input: "image" },
          template: { node: "475", input: "image" },
          prompt: { node: "459:474", input: "prompt" },
          steps: { node: "459:458", input: "steps", cast: Number },
          seed: { node: "459:458", input: "seed", cast: Number },
        },
        required: ["figure", "prompt"],
        dropWhenEmpty: { template: ["475"] },
        defaults: { steps: 8 },
        params: ["seed", "steps"],
      },
      /* AND FLUX.3 KLEIN DRAWS A BOARD, which is the job it is best suited to
       * on this rail - Babe, 2026-10-29: "right now its only nano.. can we add
       * qwen and flux". BFL's own upsampler prompt names pages, charts, grids
       * and posters as the things that decompose into regions with a box each,
       * and a shot board is exactly that. Same two loaders as 01, 02 and 03,
       * with this rung's names on them.
       * THE FIGURE LEADS AND THE PAGE FOLLOWS, which is the opposite of 02 and
       * for the same reason read the other way round: `ReferenceMultiLatent`
       * sizes the latent from its first reference and `images.image0` must be
       * filled, so the one that DROPS can never be slot 0 - and here it is the
       * page, which SINGLE and CUSTOM do not send at all. So the frame decides
       * the shape, which is what SINGLE wants outright (a re-frame comes back
       * the shape of what it re-frames) and what a board can live with, since
       * 03 hands this rung a 16:9 frame and the six-panel page is 16:9 too.
       * AND THE SHEET IS NOT HERE, the same as the two rows above: it is nano's
       * third reference and this graph has two loaders, so the paragraph naming
       * it is never composed. */
      "FLUX-3-KLEIN": {
        graph: "flux3-klein-2ref.json",
        label: "The board",
        sys: (v) =>
          BOARD_LINE(v.light, v.mode === "single", !!v.template,
                     "<ref_image_0>", "<ref_image_1>"),
        modes: { custom: { sys: () => FREE_LINE("<ref_image_0>") } },
        inputs: {
          figure: { node: "11", input: "image" },
          template: { node: "12", input: "image" },
          prompt: { node: "100", input: "value" },
          steps: { node: "7", input: "steps", cast: Number },
          seed: { node: "7", input: "seed", cast: Number },
        },
        required: ["figure", "prompt"],
        dropWhenEmpty: { template: ["12"] },
        defaults: { steps: 16 },
        params: ["seed", "steps"],
      },
    },
  },
  5: {
    graph: "seedance25-ref.json",
    model: "SEEDANCE-2.5",
    label: "Put them in motion",
    traits: "motion",
    /* NEVER DESCRIBE THE PERSON IN WORDS HERE. ByteDance enforces a likeness
     * policy on its side: a prompt describing a person comes back as an
     * opaque job_failed with no reason attached, while the same prompt
     * without one runs. The identity has to arrive as a reference image, and
     * the instruction's job is to say so and then talk only about movement. */
    /* AND IT NO LONGER PROMISES ONE TAKE - Babe, 2026-10-26: "so if i say two
     * shots it knows, [shot 01 0-2s)". It opened "One continuous take built
     * from the reference frame", which is the scaffolding FORBIDDING the one
     * thing the direction above it had just asked for: the two-directors trap
     * this rail has paid for on three rungs, arriving on the fourth. How many
     * shots there are is the artist's, so the scaffolding stops having an
     * opinion about it and goes on holding the only thing that is its own -
     * the references, and the likeness that must not travel as words. */
    sys: (v) => SHOOT_SYS(v.mode),
    /* THE BOARD IS image_1 NOW, AND THE HERO FRAME IS NOT A REFERENCE AT ALL.
     * The first real clip was handed the hero frame AND the board - the same
     * scene at two different framings - and came back as a medium shot that
     * was neither. Babe, 2026-10-25: "it should be image to video. using the
     * direction frame, not the hero frame. the hero frame was used for the
     * style and prob doesnt need to be used as a ref again".
     * THE BOARD ALREADY IS THE HERO FRAME RESTAGED: same character, same
     * place, same light, plus the framing that was chosen. It is strictly
     * more specific, so feeding both gives the model two answers to one
     * question and it averages them. The sheet stays, because it is the only
     * answer to a different question - who they are at angles this frame does
     * not show. The hero frame keeps its place on the rung as the thing the
     * board is drawn FROM; it just stops riding along into the clip.
     * Node 4 is the graph's third loader and nothing feeds it now, so it is
     * dropped outright rather than left dangling. */
    inputs: {
      board: { node: "2", input: "image" },
      sheet: { node: "3", input: "image" },
      prompt: { node: "9", input: "model.prompt" },
      /* THE NODE'S OWN TWO, WHICH NOTHING ON THE PAGE COULD REACH UNTIL NOW.
       * `adaptive` is the default and it means follow the references - which
       * on a rung whose left slot is a frame somebody already framed is the
       * right answer most of the time, and is what every clip made here
       * before today was made with. */
      ar: { node: "9", input: "model.ratio" },
      size: { node: "9", input: "model.resolution" },
      duration: { node: "9", input: "model.duration", cast: Number },
      seed: { node: "9", input: "seed", cast: Number },
    },
    required: ["board", "prompt"],
    defaults: { duration: 5, ar: "adaptive", size: "1080p" },
    /* ITS VOCABULARY IS ITS OWN: no 2:3 and no 3:2, and an `adaptive` nothing
     * else on the rail has. Seedance 2.5 stops at 1080p - 4k is the 2.0
     * node's - so the list is the three the model will take. */
    options: { ar: ["adaptive", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
               size: ["480p", "720p", "1080p"] },
    drop: ["4"],
    /* the sheet takes its loader and its link with it when it did not arrive,
     * so the rung still runs on whatever it was actually given. */
    dropWhenEmpty: { sheet: ["3"] },
    params: ["ar", "size", "duration", "seed"],
    /* THE FIRST GENERATION, IN THE DIRECTION PANEL. Same two references the
     * sheet rung takes - a picture to hold and a page to fill - and the same
     * three models, because this is the same kind of job: a layout problem
     * before it is a rendering one. The page rasterises whichever mode was
     * picked and uploads it, exactly as it does for 02's preset. */
    modes: {
      transition: {
        graph: "seedance25-flf.json",
        sys:
          "@image1 is the frame the shot opens on and @image2 is the frame it "
          + "ends on. Hold the character, the wardrobe and the lighting exactly as "
          + "those frames have them and do not describe their appearance in words; "
          + "fill the time between them as the direction says.",
        inputs: {
          start: { node: "41", input: "image" },
          last: { node: "40", input: "image" },
          prompt: { node: "38", input: "model.prompt" },
          duration: { node: "38", input: "model.duration", cast: Number },
          seed: { node: "38", input: "seed", cast: Number },
        },
        /* THE LAST FRAME IS REQUIRED, AND NOTHING CAN SUPPLY IT YET. That is
         * the honest state of this mode: node 40 ships with image: "", so
         * leaving `last` optional meant a press of RUN submitted a
         * first-last-frame job with no last frame in it - a malformed job
         * that fails at Comfy with Comfy's words rather than here with ours.
         * It refuses for its real reason now, and will stop refusing the day
         * the panel has somewhere to put a second picture. */
        required: ["start", "last", "prompt"],
      },
    },
    variants: {
      /* AND THIS ROW COULD ONLY EVER REFUSE. Its input was keyed `start`,
       * which is what 04's left slot was called before the six - this rung's
       * is `board`, so the one picture the graph needs never arrived and the
       * row answered "needs start" to a slot with a board in it. Found by the
       * free sweep, not by spending on it.
       * AND IT TAKES THE SAME SENTENCE, because it is handed the same grid. */
      "LTX-2.5 I2V": {
        graph: "ltx25-i2v.json",
        label: "Put them in motion",
        sys: (v) => SHOOT_SYS(v.mode),
        inputs: {
          board: { node: "395", input: "image" },
          prompt: { node: "398:376", input: "value" },
          duration: { node: "398:362", input: "value", cast: Number },
          seed: { node: "398:339", input: "noise_seed", cast: Number },
        },
        required: ["board", "prompt"],
        defaults: { duration: 5 },
        params: ["duration", "seed"],
      },
      /* MINIMAX H3, ON THE OPEN WEIGHTS - Babe, 2026-10-27: "h3 is local
       * now", "they have both". It is the same model name 06 runs as a
       * partner API node and a different thing underneath: a 19.5GB
       * `minimax_h3_ref2va` checkpoint with its own two VAEs, a 32B text
       * encoder and `api_node: false`. The row on this rung had been the
       * partner name with no variant behind it - a seat that could only
       * refuse - and its receipt already read `open weights`, which was a
       * lie about a row that did not run. Both halves are true now.
       *
       * ZERO CREDITS, GPU TIME ONLY, which is what this rail means by an open
       * row. Priced at 0 before anything was submitted.
       *
       * THE JOB IS 05's AND IT COPIES ACROSS UNCHANGED - the slate on
       * `<Picture 1>`, the sheet on `<Picture 2>`, the same two references
       * SEEDANCE takes and the same question asked of them. What changes is
       * the vocabulary, which is why H3_R2V_SYS exists.
       *
       * THE LIGHTNING SWITCH STAYS IN THE GRAPH AND IS ON. Node 146 picks
       * between the base model at 20 steps and the 4-step `ref2v` turbo LoRA;
       * the template ships it OFF, and this rung ships it ON, because a rung
       * somebody waits in front of is worth four steps and the guide's own
       * cost is "slightly weaker audio and motion". Flip 146 to false for the
       * 20-step row. DO NOT CROSS THE LORAS: the `ref2v` turbo belongs to the
       * `ref2va` model, the `fl2v` one to the t2v/i2v weights.
       *
       * AND THE DURATION IS SECONDS, NOT FRAMES. Node 132 is a float the
       * graph's own math expression rounds onto H3's 17-frames-per-block grid
       * at 24fps, so the row's SECONDS cell reaches it unconverted - the one
       * reason the length is patched on a primitive rather than on the node
       * that takes it. 124 frames is ~5s and the trained range starts there,
       * so SECONDS 4 is under it. */
      "MINIMAX-H3": {
        graph: "minimax-h3-r2v.json",
        model: "MINIMAX-H3",
        label: "Put them in motion",
        sys: (v) => H3_R2V_SYS(v.mode, !!v.sheet),
        inputs: {
          board: { node: "137", input: "image" },
          sheet: { node: "139", input: "image" },
          prompt: { node: "138", input: "value" },
          /* THE LATENT IS SIZED BY A RESOLUTIONSELECTOR, so the shape and the
           * size are one node and two widgets rather than a width and a
           * height on the model node - 136 reads both as links. `multiple`
           * stays at the graph's 32, which is what makes 0.98 at 16:9 come
           * out as the 1344x768 this row was proven at. */
          ar: { node: "115", input: "aspect_ratio", cast: (v) => AR_LABEL[v] || v },
          size: { node: "115", input: "megapixels", cast: (v) => AR_MP[v] || Number(v) || 0.98 },
          duration: { node: "132", input: "value", cast: Number },
          seed: { node: "129", input: "noise_seed", cast: Number },
        },
        required: ["board", "prompt"],
        defaults: { duration: 5, ar: "16:9", size: "720p" },
        /* the sheet takes its loader with it, and the reference slot on the
         * conditioning node goes when the loader does - `<Picture 2>` stops
         * being named by the sentence in the same breath, because `sys` reads
         * the values the drops were taken out of. */
        dropWhenEmpty: { sheet: ["139"] },
        /* AND NO `adaptive` HERE: this row builds its own latent, so there is
         * nothing for a ratio to adapt TO - the shape has to be stated. The
         * eight the cell already offers are exactly the eight the node takes. */
        params: ["ar", "size", "duration", "seed"],
      },
    },
  },
};

const graphCache = new Map();
async function loadGraph(name) {
  if (!graphCache.has(name)) {
    graphCache.set(name, JSON.parse(await readFile(join(HERE, "graphs", name), "utf8")));
  }
  return structuredClone(graphCache.get(name));
}

/* ------------------------------------------------------------------ helpers */

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req, cap = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > cap) { reject(new Error("too large")); req.destroy(); return; }
      parts.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

/* Comfy's terminal states. Success is "completed", NOT "success" — testing for
 * the wrong word does not throw, it just polls a finished job forever. */
const DONE = new Set(["completed", "error", "cancelled", "failed", "success", "non_retryable_error", "lost"]);
const OK = new Set(["completed", "success"]);

/* Outputs is a free-form passthrough of ComfyUI's own object, so walk every
 * array under every node id and keep whatever carries a filename. */
function outputFiles(detail) {
  const found = [];
  const seen = new Set();
  for (const [node, bucket] of Object.entries(detail?.outputs ?? {})) {
    if (!bucket || typeof bucket !== "object") continue;
    for (const list of Object.values(bucket)) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (!item || typeof item.filename !== "string" || !item.filename) continue;
        const subfolder = typeof item.subfolder === "string" ? item.subfolder : "";
        const key = `${subfolder}/${item.filename}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({ filename: item.filename, subfolder, type: item.type || "output", node });
      }
    }
  }
  const saved = found.filter((f) => f.type === "output");
  return saved.length ? saved : found;
}

/* AND SOMETIMES WHAT COMES BACK IS WORDS. An output node that previews a
 * value puts it in the same free-form outputs object as a filename, under
 * `text`, so the walk is the same walk - a job either made files or said
 * something, and a rung that reads a picture does the second. */
function outputText(detail) {
  const said = [];
  for (const bucket of Object.values(detail?.outputs ?? {})) {
    if (!bucket || typeof bucket !== "object") continue;
    for (const [key, list] of Object.entries(bucket)) {
      if (key !== "text" && key !== "string" && key !== "value") continue;
      for (const item of Array.isArray(list) ? list : [list]) {
        if (typeof item === "string" && item.trim()) said.push(item);
      }
    }
  }
  return said;
}

/* "failed" is not a reason. The reason is in the job detail, one free GET on a
 * job that has already stopped. */
function errorText(detail) {
  const e = detail?.execution_error || detail?.error;
  if (!e) return "";
  const where = [e.node_type, e.node_id && `#${e.node_id}`].filter(Boolean).join(" ");
  return [where, e.exception_message || e.message].filter(Boolean).join(": ");
}

/* --------------------------------------------------------------- the routes */

async function apiUpload(req, res, url) {
  const name = url.searchParams.get("name") || `drop-${Date.now()}.png`;
  const type = req.headers["content-type"] || "application/octet-stream";
  const bytes = await readBody(req);
  if (!bytes.length) return json(res, 400, { error: "empty upload" });

  const form = new FormData();
  form.append("image", new Blob([bytes], { type }), name);
  form.append("type", "input");
  form.append("overwrite", "true");

  // no Content-Type header here: fetch has to set the multipart boundary
  const up = await fetch(`${BASE}/api/upload/image`, { method: "POST", headers: headers(), body: form });
  if (!up.ok) return json(res, 502, { error: `upload failed (${up.status}) ${await up.text()}` });
  const out = await up.json();
  json(res, 200, { name: out.name || name, subfolder: out.subfolder || "" });
}

async function apiRun(req, res) {
  const body = JSON.parse((await readBody(req)).toString() || "{}");

  let base = RUNGS[body.rung];
  if (!base) return json(res, 400, { error: `unknown workflow ${body.rung}` });

  /* A RUNG CAN HAVE MORE THAN ONE GENERATION IN IT. 04 has two: the DIRECTION
   * panel draws a board, and then the board, the hero frame and the sheet go
   * to the video model. They are different models doing different jobs, so a
   * step replaces the rung outright rather than overriding parts of it - and
   * because it lands before the model is picked, each step keeps its own row
   * of models and its own default. */
  if (body.step && base.steps && base.steps[body.step]) base = base.steps[body.step];

  /* the chosen model picks the graph; an unknown one is refused rather than
   * quietly running the default and looking like the picker does nothing. */
  let spec = base;
  if (body.model && body.model !== base.model) {
    spec = (base.variants || {})[body.model];
    if (!spec) return json(res, 400, { error: `${body.model} is not wired` });
  }

  /* AND THE MODE IS A SECOND AXIS. `variants` keys a rung by model, which was
   * enough while a rung made one kind of thing. 04 does not: SINGLE and
   * SEQUENCE are the same graph with a different number of references in it,
   * but TRANSITION is a different node entirely - first frame, last frame,
   * the model fills the middle - so the table needs mode as well as model.
   * The mode's entry overrides whatever it names and inherits the rest, so a
   * model that treats every mode alike says nothing here. */
  /* A ROW THAT DOES ONE JOB SAYS SO. SCAIL-2 replaces a performer and
     cannot recast or extend, so `only` pins the mode rather than letting a
     tab promise a job the graph has no way to do. */
  const mode = spec.only || body.mode || null;
  if (mode && spec.modes && spec.modes[mode]) {
    spec = { ...spec, ...spec.modes[mode] };
  }

  const values = { ...(spec.defaults || {}), ...(body.values || {}) };

  /* A DEFAULT LOSES TO AN EMPTY STRING. The page sends every field whether or
   * not it holds anything, so `defaults` cannot stand in for a line the
   * artist cleared — `blankTo` is the floor under one that arrives blank. */
  for (const [key, v] of Object.entries(spec.blankTo || {})) {
    if (values[key] === undefined || values[key] === "") values[key] = v;
  }

  /* scaffolding first, the artist's line last, so what they typed has the
   * final word over it. A function gets the values, because a rung whose
   * params shape the instruction (02's VIEWS) cannot hold it as a string.
   * Mapping `sys` in `inputs` says this model has a system prompt of its own
   * and wants it there instead of glued to the front of what they wrote. */
  /* A CUSTOM PROMPT ARRIVES UNDRESSED. `raw` says the artist wrote this line
   * themselves rather than accepting one the agent composed, and the rung's
   * scaffolding is written for the second case - in front of the first it is
   * a second director talking over them. */
  /* THE MODE IS PART OF THE QUESTION THE SENTENCE ANSWERS, so it has to be
     in front of `sys` - it arrives beside the values rather than among them,
     and composing from values alone gave every mode the base sentence.
     THE DROPPED NODES GO WITH IT: a mode that takes a loader out must not
     leave the prompt addressing it. The sentence and the graph have to
     describe the same job, which is the whole reason the dry run prints
     both. */
  /* `drop` is a node this rung does not have; `dropWhenEmpty` is one it has
     and nobody filled. It is worked out here rather than beside the graph
     because the SENTENCE needs it too: a mode that takes a loader out must
     not leave the prompt addressing it. */
  const drops = [...(spec.drop || [])];
  for (const [key, nodes] of Object.entries(spec.dropWhenEmpty || {})) {
    if (!values[key]) drops.push(...nodes);
  }

  const seen = { ...values, mode: spec.only || mode };
  for (const id of new Set(drops)) {
    for (const [key, def] of Object.entries(spec.inputs)) {
      if (def.node === id) delete seen[key];
    }
  }
  const sys = typeof spec.sys === "function" ? spec.sys(seen) : spec.sys;

  /* WHAT THIS RUNG DOES WITH THE CHARACTER'S OWN FACTS, read off the BASE and
   * not off the resolved spec: a variant REPLACES the spec outright, so a flag
   * on the base is one declaration a row cannot lose - the same reason `steps`
   * lands before the model is picked. `keep` files them, `note` tells an
   * image model, `motion` tells a video model and includes the voice. */
  const use = base.traits || "";
  const note = use === "note" || use === "motion"
    ? TRAIT_NOTE(values.traits, use === "motion")
    : "";
  const dressed = [sys, note].filter(Boolean).join(" ");
  if (dressed && !body.raw) {
    if (spec.inputs.sys) values.sys = dressed;
    else values.prompt = [dressed, values.prompt].filter(Boolean).join(" ");
  }
  if (values.seed === undefined || values.seed === "") {
    values.seed = Math.floor(Math.random() * 2 ** 31);
  }

  for (const key of spec.required) {
    if (values[key] === undefined || values[key] === "") {
      return json(res, 400, { error: `${spec.label} needs ${key}` });
    }
  }

  const graph = await loadGraph(spec.graph);

  for (const [key, def] of Object.entries(spec.inputs)) {
    let v = values[key];
    if (v === undefined || v === "") continue;
    if (def.cast) v = def.cast(v);
    for (const addr of [def, ...(def.also || [])]) {
      const target = graph[addr.node];
      if (!target) return json(res, 500, { error: `node ${addr.node} is not in ${spec.graph}` });
      (target.inputs ||= {})[addr.input ?? def.input] = v;
    }
  }

  // taking a node out means taking every reference to it out too
  if (drops.length) {
    for (const id of new Set(drops)) delete graph[id];
    for (const node of Object.values(graph)) {
      for (const [k, v] of Object.entries(node.inputs ?? {})) {
        if (Array.isArray(v) && !graph[String(v[0])]) delete node.inputs[k];
      }
    }
  }

  /* DRY RUN. Everything above this line is free; everything below it spends.
   * `{"dry":true}` stops here and reports what the patch did, which is how
   * you check a new model's wiring without paying to find out it was wrong.
   * Verifying the variant routing by submitting three real jobs cost a nano
   * run; this exists so that does not happen twice. */
  if (body.dry) {
    const patched = {};
    for (const [key, def] of Object.entries(spec.inputs)) {
      const addrs = [def, ...(def.also || [])];
      patched[key] = addrs.map((ad) => {
        const node = graph[ad.node];
        return node
          ? `${ad.node}.${ad.input ?? def.input} (${node.class_type})`
          : `MISSING node ${ad.node}`;
      });
    }
    return json(res, 200, {
      dry: true,
      model: spec.model || body.model || "default",
      graph: spec.graph,
      nodes: Object.keys(graph).length,
      dropped: [...new Set(drops)],
      patched,
      /* the addresses are half the wiring; the sentence that lands on them is
       * the other half. A rung whose params shape the instruction (02's
       * VIEWS) cannot be checked without reading it back. */
      sent: { prompt: values.prompt, ...(values.sys ? { sys: values.sys } : {}) },
    });
  }

  /* WHOSE SITTING THIS RUN BELONGS TO, settled here because this is the
   * first moment anything is written on their behalf - and read by `keep()`,
   * which is called from a POLL and has no visitor on it. */
  const visitor = DEMO ? (visitorSession(req) || mintVisitor(req, res)) : "";

  const sub = await fetch(`${BASE}/api/prompt`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({ prompt: graph, extra_data: extraData() }),
  });
  const text = await sub.text();
  if (!sub.ok) return json(res, 502, { error: `submit refused (${sub.status}) ${text}` });

  let out = {};
  try { out = JSON.parse(text); } catch {}
  const jobId = out.prompt_id || out.id;
  if (!jobId) return json(res, 502, { error: `no job id in response: ${text.slice(0, 400)}` });

  /* remember what made this, so the finished file can be filed under it */
  JOBS.set(jobId, {
    /* AND WHOSE IT IS, on a shared instance - see keep(). Empty on the
     * machine somebody installed this on, where the session is simply the
     * sitting that is current. */
    session: visitor,
    /* the section number, which is what every part of the page already
     * calls it. `random` is the one entry that is not on the rail. */
    rungName: /^\d+$/.test(String(body.rung))
      ? String(body.rung).padStart(2, "0")
      : slug(String(body.rung)),
    modelSlug: slug(spec.model || body.model || ""),
    seed: values.seed,
    /* THE FACTS GO WITH THE FILE, so the record is the picture plus what it
     * cannot say. Only the rung that owns them writes one. */
    bible: use === "keep" && values.traits && Object.keys(values.traits).length
      ? { traits: values.traits, sheet: values.sheet || "" }
      : null,
  });

  console.log(`  -> ${body.rung} submitted  ${jobId}  seed ${values.seed}`);
  json(res, 200, { jobId, seed: values.seed });
}

async function apiJob(res, id) {
  const st = await fetch(`${BASE}/api/job/${id}/status`, { headers: headers() });
  /* A JOB WE JUST SUBMITTED IS NOT AN UNKNOWN JOB, AND THAT COST AN AGENT -
   * Babe, 2026-10-29: "agent is not working". It was: the same question,
   * asked of the same server a minute later, came back with a beach written
   * exactly as the panel asks for. WHAT FAILED WAS THE FIRST POLL. Comfy
   * answers 404 for a few hundred milliseconds between handing back a job id
   * and being able to report on it, this turned that into a 502, and the
   * page ends a run on any poll that is not ok - correctly, for a poll that
   * means anything. So a job that was about to succeed was killed two
   * seconds after it started, and nothing anywhere said why.
   * THE SERVER IS WHERE THIS BELONGS, because the server is the only thing
   * that knows the difference: it SUBMITTED this one, so a 404 against an id
   * in `JOBS` means not yet, and a 404 against anything else means no such
   * job. A retry in the client would be a second mechanism guessing at what
   * this one can simply answer. */
  const made = JOBS.get(id);
  if (!st.ok) {
    /* WHICH FAILURES ARE A MOMENT AND WHICH ARE AN ANSWER. A 404 is Comfy
     * not knowing the id yet, a 429 or a 5xx is it being unable to say, and
     * all three are worth asking again. A 401 or a 403 is a refusal that
     * will be a refusal next time too, so it goes straight through - a key
     * that stopped working must not read as a job that is still running. */
    const again = st.status === 404 || st.status === 408 || st.status === 429
      || st.status >= 500;
    if (made && again && (made.misses = (made.misses || 0) + 1) <= JOB_MISSES) {
      console.log(`  .. ${id} status ${st.status} (${made.misses}/${JOB_MISSES}) - asking again`);
      return json(res, 200, { state: "waiting", done: false });
    }
    return json(res, 502, { error: `status failed (${st.status})` });
  }
  /* and a poll that answered puts the count back, so five scattered hiccups
   * over a long job are five hiccups rather than a death */
  if (made) made.misses = 0;
  const state = (await st.json()).status;

  if (!DONE.has(state)) return json(res, 200, { state, done: false });

  // the filenames only exist on the detail endpoint, and only once terminal.
  // note the plural: /api/jobs/<id>, unlike the status path above.
  const det = await fetch(`${BASE}/api/jobs/${id}`, { headers: headers() });
  const detail = det.ok ? await det.json() : {};
  const ok = OK.has(state);
  const files = outputFiles(detail);

  /* keep a copy before answering, so the folder is complete whether or not
   * anyone presses Save */
  const kept = ok ? await Promise.all(files.map((f) => keep(id, f))) : [];
  if (kept.some(Boolean)) console.log(`  <- kept ${kept.filter(Boolean).join(", ")}`);

  json(res, 200, {
    state,
    done: true,
    ok,
    error: ok ? "" : errorText(detail) || state,
    text: outputText(detail),
    outputs: files.map((f, i) => ({
      ...f,
      saved: kept[i] || null,
      url: `/api/file?filename=${encodeURIComponent(f.filename)}&subfolder=${encodeURIComponent(f.subfolder)}&type=${encodeURIComponent(f.type)}`,
    })),
  });
}

/* A rung's output has to become the next rung's input, and Comfy keeps those in
 * two different folders. Copy it across server-side: a 5s clip has no business
 * travelling to the browser and back just to change folders. */
/* What is already on disk, newest first. The page uses it to stage a result
 * without running anything, so the flow after a rung can be worked on
 * without paying for a rung. */
/* WHICH SITTING THIS IS, AND HOW TO START ANOTHER. A GET says which session
 * is current and what else is on disk; a POST starts a new one and makes it
 * current. Nothing is ever deleted or moved - the old session keeps its
 * folder, its files and its own journey in the browser, and switching back is
 * the same POST with a name on it.
 * THE DAY IS TODAY'S WHATEVER HAPPENS, so a session started tonight and
 * worked on tomorrow is still one session - which is what it is. */
/* A THUMBNAIL IS NOT THE PICTURE. The review grid draws tiles 245px wide
 * and was handing the browser the originals to do it - 2K PNGs and 720p
 * clips, fifteen at a time for one screenful. Opacity is all a cascade can
 * animate, so each tile still painted whenever it finished DECODING, and
 * the grid filled in at random however the reveal was eased. Babe,
 * 2026-10-28: "theres no real build to this page", "it feels random".
 * SO THE PANEL ASKS FOR SOMETHING TILE-SIZED. 320px JPEG, made once with
 * ffmpeg and kept in output/.thumbs under the source's own path, so it is
 * made once per file ever and a moved file simply makes a new one. A clip's
 * thumbnail is its first frame, which is the seek `plateFromClip` already
 * does in the browser - doing it here is why the grid stops loading twenty
 * videos to show twenty stills.
 * IT IS LOCAL-ONLY AND BOUNDED TO output/, like every other reader here. */
async function apiThumb(res, url) {
  const want = String(url.searchParams.get("path") || "");
  if (!want.startsWith("output/") || want.includes("..")) {
    return json(res, 400, { error: "a thumbnail is only ever of something in output/" });
  }
  const src = join(HERE, want);
  if (!existsSync(src)) return json(res, 404, { error: "no such file" });
  const key = want.replace(/^output[\/]/, "").replace(/[\/]/g, "-").replace(/.[^.]+$/, "") + ".jpg";
  const dir = join(OUT, ".thumbs");
  const dst = join(dir, key);
  if (!existsSync(dst)) {
    mkdirSync(dir, { recursive: true });
    const vid = /.(mp4|mov|webm|m4v)$/i.test(want);
    const args = (vid ? '-ss 0 -i "' + src + '" -frames:v 1' : '-i "' + src + '"') +
                 ' -vf scale=320:-2 -q:v 6 "' + dst + '"';
    await new Promise((go) => exec("ffmpeg -v error -y " + args, () => go()));
  }
  /* AND A FILE ffmpeg COULD NOT READ FALLS BACK TO THE ORIGINAL rather than
   * to a broken tile: the grid showing a heavy picture is a slow panel, and
   * the grid showing nothing is a lost file. */
  if (!existsSync(dst)) return await serveStatic(res, "/" + want);
  res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "max-age=86400" });
  return res.end(readFileSync(dst));
}

async function apiSession(req, res, url) {
  if (req.method === "POST") {
    /* `readBody` RETURNS BYTES, not an object - the other two POST handlers
       both parse it, and a body read as an object here would have made every
       named switch look like a request for a new session. */
    let body = {};
    try { body = JSON.parse((await readBody(req)).toString() || "{}"); } catch { /* new session */ }
    const want = String(body && body.session || "");
    const { day } = stamp();
    let name;
    /* ON A DEMO A SITTING IS SOMEBODY'S, so going back to one means going
     * back to your own and `?session=new` means a fresh one with the cookie
     * re-pointed at it. Any other name is refused in the words the client
     * already handles - it is not that the sitting does not exist, it is
     * that it is not yours, and a stranger has no business learning the
     * difference. The old one keeps its folder, as always. */
    if (DEMO) {
      const mine = visitorSession(req);
      if (want) {
        if (want !== mine) return json(res, 400, { error: `no such session: ${want}` });
        return json(res, 200, { session: mine, day: sessionDay(mine) });
      }
      name = mintVisitor(req, res);
      return json(res, 200, { session: name, day: sessionDay(name) });
    }
    if (want) {
      if (!/^session\d+$/.test(want) || !existsSync(join(OUT, want))) {
        return json(res, 400, { error: `no such session: ${want}` });
      }
      writeFileSync(join(OUT, CURRENT), want + "\n");
      name = want;
    } else {
      name = makeSession(day);
    }
    return json(res, 200, { session: name, day: sessionDay(name) });
  }
  /* THE GET MAKES NOTHING. It asked `sessionDir` for an answer, which
     CREATES one when the day has none - so merely loading the page on a new
     day started a session, and the POST that followed started another. A read
     that writes is a read nobody can call twice. With no answer the client
     behaves as it did before sessions existed, and the first file written
     makes the folder. */
  /* AND ON A DEMO THIS IS WHERE A VISITOR GETS ONE. The page asks which
   * sitting it is in before it restores anything or dresses anything, which
   * makes this the one place a cookie can be handed over in time to matter -
   * and the listing is theirs alone, because the sittings on this disk are
   * other people's. */
  if (DEMO) {
    const mine = visitorSession(req) || mintVisitor(req, res);
    return json(res, 200, {
      session: mine,
      sessions: [{ name: mine, day: sessionDay(mine) }]
    });
  }
  const names = sessionNames();
  const today = stamp().day;
  const cur = currentSession() ||
              names.find((n) => sessionDay(n) === today) || "";
  return json(res, 200, {
    session: cur,
    sessions: names.map((n) => ({ name: n, day: sessionDay(n) }))
  });
}

/* THE BROWSER IS A FORM AND THE SERVER IS THE KEEPER.
 *
 * Anybody who installs this has a Comfy key and nowhere to put it, and the
 * instruction "make a file called .env" is the whole install for most people.
 * So the bar has a button, and the only thing the browser ever does with the
 * key is hand it over once: it is written to .env, it is never sent back, and
 * /api/health goes on reporting `set` or `MISSING` rather than anything about
 * what it says. The page can ask whether there is a key; it can never read it.
 *
 * THREE REFUSALS, AND EACH ONE IS A DIFFERENT QUESTION:
 *
 *  - NOT FROM ANOTHER MACHINE. The server binds to 127.0.0.1, so this is
 *    belt and braces - but writing a credential is the one endpoint where
 *    "it is only a local dev server" stops being an excuse the day somebody
 *    puts it behind a tunnel to show a friend.
 *  - NOT WHEN THE ENVIRONMENT HAS ONE. `loadKey` prefers COMFY_API_KEY from
 *    the environment, so a file written under it would be ignored and the
 *    panel would be lying about what is in use. Say so instead.
 *  - NOT WITHOUT ASKING COMFY. /api/user is a free read, so a typo is caught
 *    at the moment of pasting rather than on the first press that spends. */
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/* NOTHING THAT TALKS TO COMFY ANSWERS UNTIL THERE IS A KEY, AND THE LIST IS
 * INVERSE ON PURPOSE. These four are local-only - they read this machine and
 * nothing else - and everything else under /api/ ends up at cloud.comfy.org,
 * so an endpoint added next month is refused by default rather than found out
 * by a 401 arriving in Comfy's words two layers from the person reading it.
 * A refusal here is also the only reason the page can say what to do about
 * it: this sentence is written for somebody who has just installed this. */
const LOCAL_ONLY = new Set(["/api/health", "/api/key", "/api/session", "/api/output", "/api/take", "/api/thumb"]);

async function apiKey(req, res) {
  /* AND THE TWO REFUSALS ABOVE ARE ABOUT WRITING A FILE, which is why a demo
   * is exempt from them rather than refused by them. On the machine somebody
   * installed this on, a key pasted here is written to .env and belongs to
   * that machine - so it may only be set FROM that machine, and an
   * environment that already has one wins. On a shared instance the key is
   * the visitor's, nothing is written, and the only thing either test could
   * do is stop a judge getting in: a reverse proxy arrives AS loopback
   * anyway, so the first test cannot even see the difference it is for. */
  const from = req.socket.remoteAddress || "";
  if (!DEMO && !LOOPBACK.has(from)) {
    return json(res, 403, { error: "the key can only be set from this machine" });
  }
  if (!DEMO && process.env.COMFY_API_KEY) {
    return json(res, 409, {
      error: "COMFY_API_KEY is set in this terminal's environment and that wins over .env — unset it and restart to save a key here"
    });
  }

  let body = {};
  try { body = JSON.parse((await readBody(req, 8 * 1024)).toString() || "{}"); } catch { /* below */ }
  const key = String((body && body.key) || "").trim();
  if (!key) return json(res, 400, { error: "there was no key in that" });
  /* A PASTE THAT BROUGHT A LINE BREAK OR A `COMFY_API_KEY=` WITH IT is the
     likeliest thing to arrive here, and both make a file that loads as
     something else entirely. */
  if (/\s/.test(key)) return json(res, 400, { error: "that has a space or a line break in it — paste the key on its own" });

  try {
    const r = await fetch(`${BASE}/api/user`, { headers: headersFor(key) });
    if (r.status === 401 || r.status === 403) return json(res, 400, { error: "Comfy refused that key" });
    if (!r.ok) return json(res, 502, { error: `Comfy answered ${r.status} — nothing was saved` });
  } catch (err) {
    return json(res, 502, { error: `could not reach Comfy: ${err.message}` });
  }

  /* ON A DEMO IT IS KEPT FOR THIS VISITOR AND NOWHERE ELSE. Comfy has just
     confirmed the key, which is the same check the installed app makes - the
     panel, the sentence and the press are identical, and all that differs is
     that this one hands it to a Map instead of a file. The sitting is minted
     if they somehow have no cookie yet, because a key with nobody to belong
     to is a key the next request cannot find. */
  if (DEMO) {
    const who = visitorSession(req) || mintVisitor(req, res);
    DEMO_KEYS.set(who, { key, at: Date.now() });
    /* THE LENGTH, NEVER THE KEY - and not whose, either: a demo's log is a
       line in somebody else's terminal. */
    console.log(`  a visitor unlocked ${who} (${key.length} chars)`);
    return json(res, 200, { ok: true, key: "set", chars: key.length });
  }

  /* THE FILE MAY HOLD OTHER THINGS, so the line is replaced and everything
     else is left exactly as it was - a .env rewritten from scratch is a
     config somebody loses by pressing a button in a browser. */
  const envFile = join(HERE, ".env");
  let lines = existsSync(envFile) ? readFileSync(envFile, "utf8").split(/\r?\n/) : [];
  let replaced = false;
  lines = lines.map((line) => {
    if (!/^\s*COMFY_API_KEY\s*=/.test(line)) return line;
    replaced = true;
    return `COMFY_API_KEY=${key}`;
  });
  if (!replaced) {
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    lines.push(`COMFY_API_KEY=${key}`);
  }
  try {
    writeFileSync(envFile, lines.join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
    /* `mode` only applies to a file this call creates, so an existing .env
       keeps whatever it had until it is told. Windows has no mode to set and
       throws nothing worth stopping for. */
    try { chmodSync(envFile, 0o600); } catch { /* not on this filesystem */ }
  } catch (err) {
    return json(res, 500, { error: `could not write .env: ${err.message}` });
  }

  KEY = key;
  /* THE LENGTH, NEVER THE KEY. This line goes to a terminal somebody may be
     screen-sharing, and server.log is gitignored rather than secret. */
  console.log(`  key saved to .env (${key.length} chars)`);
  return json(res, 200, { ok: true, key: "set", chars: key.length });
}

/* A TAKE IS WORK, SO IT IS KEPT WITH THE REST OF IT - Babe, 2026-10-27: "when
 * you save does it go to media panel?". It did not: SAVE downloaded to a
 * browser's folder, and the panel lists output/, which only ever held what the
 * server wrote. A take never reaches the server at all unless USE sends it,
 * and then it goes to Comfy's INPUT rather than here.
 *
 * IT IS FILED UNDER `takes`, NOT UNDER A WORKFLOW NUMBER, because no workflow
 * made it - a camera did. The review panel walks output/ and shows it with no
 * section, the way a roll already appears; `fill` and `dress` ask for a
 * `/0N/` folder, so a take can never become a room.
 * THE NAME IS THE SERVER'S OWN SHAPE - HHMMSS-webcam-<ms>.<ext> - so it reads
 * like everything else in that listing and passes `madeHere`: this IS a file
 * this machine wrote. */
async function apiTake(req, res, url) {
  const bytes = await readBody(req);
  if (!bytes.length) return json(res, 400, { error: "empty take" });
  const asked = String(url.searchParams.get("name") || "take.mp4");
  const ext = (asked.match(/\.[a-z0-9]+$/i) || [".mp4"])[0].toLowerCase();
  const { day, time } = stamp();
  const session = (DEMO && (visitorSession(req) || mintVisitor(req, res))) || sessionDir(day);
  const dir = join(OUT, session, "takes");
  const name = `${time}-webcam-${Date.now() % 100000}${ext}`;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), bytes);
  } catch (err) {
    return json(res, 500, { error: `could not keep the take: ${err.message}` });
  }
  const rel = `output/${session}/takes/${name}`;
  console.log(`  <- kept ${rel}`);
  return json(res, 200, { saved: rel, name });
}

async function apiOutput(req, res) {
  const files = [];
  const sides = [];
  /* THE LISTING IS WHAT DRESSES THE RAIL, so on a shared instance it is the
   * one answer that has to be a visitor's own: `fill`, `dress`, `S` and the
   * review panel all read it. The panel showing EVERYTHING is a rule about
   * the disk of the person who made those files, and on a demo the disk is
   * other people's work. One scope here is every one of them. */
  const only = DEMO ? visitorSession(req) : "";
  if (DEMO && !only) return json(res, 200, { files: [], days: {}, traits: {} });
  async function walk(dir, rel) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const next = join(dir, e.name);
      const nextRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(next, nextRel);
      else if (/\.(png|jpe?g|webp|mp4|webm)$/i.test(e.name)) files.push(`output/${nextRel}`);
      /* A SIDECAR IS NOT A SHOT, so it is never in `files` - the review strip
       * reads that list and a JSON in it would be a cell with nothing to
       * show. It comes back keyed by the name it shares with its picture. */
      else if (/\.json$/i.test(e.name)) sides.push([e.name.replace(/\.json$/i, ""), next]);
    }
  }
  await walk(only ? join(OUT, only) : OUT, only);
  files.sort().reverse();
  /* WHICH DAY EACH SESSION WAS, because the path stopped carrying it. The
   * folder used to BE the date and now it is a session, which is the right
   * unit to browse by and the wrong one to date a file by - so the marker
   * that names the session comes back with the listing and the review panel
   * can still say when a shot was made. */
  const days = {};
  if (only) {
    days[only] = sessionDay(only);
  } else try {
    for (const e of await readdir(OUT, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      try { days[e.name] = readFileSync(join(OUT, e.name, ".day"), "utf8").trim(); }
      catch { /* a folder with no marker simply has no date */ }
    }
  } catch { /* no output/ yet */ }

  /* AND WHAT EACH CHARACTER IS, for the same reason: the listing carries what
   * the path cannot. The browser's drawer is this sitting's memory and
   * output/ is the real one, so a card with nothing in it can be filled from
   * the sheet that was actually made rather than from a preset. */
  const traits = {};
  for (const [name, path] of sides) {
    try {
      const side = JSON.parse(await readFile(path, "utf8"));
      if (side && side.traits) traits[name] = side;
    } catch { /* a sidecar that will not parse is one we do not have */ }
  }
  json(res, 200, { files, days, traits });
}

async function apiCarry(req, res) {
  const { filename, subfolder = "", type = "output", saved = "" } =
    JSON.parse((await readBody(req)).toString() || "{}");
  if (!filename) return json(res, 400, { error: "nothing to carry" });

  /* THE COPY WE OWN COMES FIRST, AND THAT IS THE WHOLE POINT OF KEEPING ONE.
   * Carrying only ever read back out of Comfy, and Comfy holds a finished
   * file for its own while - so a sheet made yesterday carried fine on the
   * day and failed with `could not read <hash>.png` the morning after, which
   * surfaced at the far end as `needs ref1` on a rung whose face was on
   * screen the whole time. Every finished file is already written under
   * output/ for exactly this reason; the page sends that path along as
   * `saved`, the same string it draws the picture from. Comfy stays as the
   * fallback for a result that has not been written down yet. */
  let bytes = null;
  let mime = "";
  const rel = saved
    ? normalize(String(saved)).replace(/\\/g, "/").replace(/^\/+/, "")
    : "";
  if (rel.startsWith("output/") && !rel.includes("..") && maySee(req, rel)) {
    try {
      /* by name if the path has moved - see findKept */
      const where = await findKept(rel);
      bytes = where ? await readFile(where) : null;
      if (!bytes) throw new Error("missing");
      mime = MIME[extname(rel)] || "application/octet-stream";
    } catch { bytes = null; }
  }

  if (!bytes) {
    const q = new URLSearchParams({ filename, subfolder, type });
    const look = await fetch(`${BASE}/api/view?${q}`, { headers: headers(), redirect: "manual" });
    const loc = look.headers.get("Location");
    const hit = loc ? await fetch(loc) : look;
    if (!hit.ok) return json(res, 502, { error: `could not read ${filename}` });
    bytes = Buffer.from(await hit.arrayBuffer());
    mime = hit.headers.get("Content-Type") || "application/octet-stream";
  }

  const form = new FormData();
  form.append("image", new Blob([bytes], { type: mime }), filename);
  form.append("type", "input");
  form.append("overwrite", "true");

  const up = await fetch(`${BASE}/api/upload/image`, { method: "POST", headers: headers(), body: form });
  if (!up.ok) return json(res, 502, { error: `carry failed (${up.status}) ${await up.text()}` });
  const out = await up.json();
  console.log(`  -> carried ${filename} into input/ as ${out.name || filename}`);
  json(res, 200, { name: out.name || filename });
}

/* The signed URL is resolved here and the bytes are piped back, so neither the
 * key nor the signature ever reaches the page. */
async function apiFile(res, url) {
  const q = new URLSearchParams({
    filename: url.searchParams.get("filename") || "",
    subfolder: url.searchParams.get("subfolder") || "",
    type: url.searchParams.get("type") || "output",
  });
  const look = await fetch(`${BASE}/api/view?${q}`, { headers: headers(), redirect: "manual" });
  const loc = look.headers.get("Location");
  const hit = loc ? await fetch(loc) : look;
  if (!hit.ok) { res.writeHead(502); return res.end("file not available"); }
  res.writeHead(200, {
    "Content-Type": hit.headers.get("Content-Type") || "application/octet-stream",
    "Cache-Control": "public, max-age=31536000, immutable",
  });
  const buf = Buffer.from(await hit.arrayBuffer());
  res.end(buf);
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".mp4": "video/mp4", ".svg": "image/svg+xml",
};

/* A KEPT FILE IS FINDABLE BY NAME ALONE, WHEREVER IT HAS MOVED TO. The
 * journey writes down the path of everything it made, and the folders under
 * output/ were restructured under it - so every plate and every held slot
 * asked for output/2026-10-24/02-take-shape/... and got a 404 and a broken
 * image. Babe, 2026-10-25: "i think some of these are missing too now".
 * REWRITING WHAT IS STORED WOULD HAVE FIXED ONE COPY OF THE PROBLEM. This
 * fixes every caller at once - the static path a plate draws from, the
 * `saved` an /api/carry reads, anything later - because the name a kept file
 * carries is already unique: a time, a model and a seed. Finding it by that
 * is not a guess.
 * It only ever looks inside output/, and only when the exact path missed. */
async function findKept(rel) {
  /* normalize() hands back backslashes on Windows, so every test here is on
   * a forward-slash copy - comparing "output/" against an `output\...` is
   * why the first version of this never fired once. */
  const slashed = String(rel).replace(/\\/g, "/");
  const exact = join(HERE, rel);
  if (existsSync(exact)) return exact;
  if (!slashed.startsWith("output/")) return null;
  const want = slashed.split("/").pop();
  let hit = null;
  async function walk(dir) {
    if (hit) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (hit) return;
      const next = join(dir, e.name);
      if (e.isDirectory()) await walk(next);
      else if (e.name === want) hit = next;
    }
  }
  /* AND ON A DEMO IT LOOKS NO FURTHER THAN THE SITTING THE PATH NAMES. The
   * reason this walks at all is that Babe moves files between sessions; a
   * visitor's never move, and a search of the whole disk is a search of
   * other people's. */
  await walk(DEMO && slashed.split("/")[1] ? join(OUT, slashed.split("/")[1]) : OUT);
  return hit;
}

async function serveStatic(res, pathname) {
  const rel = pathname === "/" ? "mockup.html" : normalize(pathname).replace(/^[\\/]+/, "");
  if (rel.includes("..") || rel.startsWith("graphs") || rel === ".env") {
    res.writeHead(404); return res.end("not found");
  }
  try {
    const found = rel.replace(/\\/g, "/").startsWith("output/")
      ? await findKept(rel)
      : join(HERE, rel);
    if (!found) throw new Error("missing");
    const bytes = await readFile(found);
    /* NEVER CACHED. This is a file on disk being edited while the page is
     * open, and a browser holding yesterday's app.js looks exactly like a
     * change that did not work - which is an hour nobody gets back. The
     * server and the page are on the same machine; there is nothing to save
     * by caching them. */
    res.writeHead(200, {
      "Content-Type": MIME[extname(rel)] || "application/octet-stream",
      "Cache-Control": "no-store, must-revalidate",
    });
    res.end(bytes);
  } catch {
    res.writeHead(404); res.end("not found");
  }
}

/* ----------------------------------------------------------------- the loop */

/* AND THE REQUEST IS WHAT HOLDS THE KEY, which is why the whole of it runs
 * inside a store. On the machine somebody installed this on that store is
 * the one key there is; on a shared one it is whichever visitor is asking,
 * or nothing at all - and `nothing` is what makes the refusal below theirs
 * rather than the instance's. See `keyNow`. */
async function route(req, res, url) {
  try {
    if (!keyNow() && url.pathname.startsWith("/api/") && !LOCAL_ONLY.has(url.pathname)) {
      return json(res, 503, { error: "no Comfy API key yet — press the key in the top right" });
    }
    /* ON A DEMO, A PICTURE UNDER output/ IS WHOSE IT IS. Nobody is handed a
     * path they did not make - the listing is scoped and so is the search
     * that heals a moved one - so this is about a path somebody typed, and
     * the answer to that is the same 404 a path that does not exist gets.
     * One gate covers the static route a plate draws from and every reader
     * that takes the path as a parameter, including the ones added later. */
    if (DEMO) {
      const asked = url.pathname.replace(/^\/+/, "").startsWith("output/")
        ? url.pathname
        : (url.searchParams.get("path") || url.searchParams.get("saved") || "");
      if (asked && !maySee(req, asked)) { res.writeHead(404); return res.end("not found"); }
    }
    if (url.pathname === "/api/upload" && req.method === "POST") return await apiUpload(req, res, url);
    if (url.pathname === "/api/run" && req.method === "POST") return await apiRun(req, res);
    if (url.pathname === "/api/carry" && req.method === "POST") return await apiCarry(req, res);
    if (url.pathname.startsWith("/api/job/")) return await apiJob(res, url.pathname.slice(9));
    if (url.pathname === "/api/file") return await apiFile(res, url);
    if (url.pathname === "/api/output") return await apiOutput(req, res);
    if (url.pathname === "/api/thumb") return await apiThumb(res, url);
    if (url.pathname === "/api/session") return await apiSession(req, res, url);
    if (url.pathname === "/api/key" && req.method === "POST") return await apiKey(req, res);
    if (url.pathname === "/api/take" && req.method === "POST") return await apiTake(req, res, url);
    if (url.pathname === "/api/health") {
      /* which model names actually have a graph behind them, per rung, so the
       * menu can disable the rest instead of failing at the press. */
      /* what each model offers AND what it wants those cells set to, so the
       * row can follow the model instead of carrying the last one's numbers
       * into it — 25 steps on an 8-step distilled checkpoint is not a
       * setting, it is a bug. */
      const wired = {};
      for (const [k, v] of Object.entries(RUNGS)) {
        const all = [[v.model, v], ...Object.entries(v.variants || {})];
        wired[k] = {};
        for (const [name, spec] of all) {
          /* AND WHAT EACH CELL IS ALLOWED TO SAY, NOT ONLY WHICH CELLS SHOW.
           * `params` hides a control the model does not take; `options` is
           * for the ones it takes with a DIFFERENT vocabulary. Seedance reads
           * 480p/720p/1080p and MiniMax H3 reads 768P/2K, so one list on the
           * slide would have let a press send a size that fails at Comfy -
           * the same shape of bug as the 768p that was never a real size for
           * either model on this rung. */
          /* AND WHICH MODE A ROW IS FOR, WHERE IT IS FOR ONLY ONE. `only`
           * has pinned the mode here since SCAIL-2, which stopped a tab
           * promising a job the graph cannot do - but it could not say so on
           * the picker, so the row sat on every tab and the refusal arrived
           * as a result that looked like it had worked. */
          /* AND WHICH INPUTS IT TAKES, so a slot cannot offer a face the
           * chosen row has no address for - Babe, 2026-10-27, on 04 with a
           * qwen row pressed: "i wonder if you choose qween then it should
           * remove the tab from the hero frame". The sheet rides image 3 on
           * nano and `TextEncodeQwenImage21` has no third reference, so SHEET
           * was a cell offering to show you a picture that was not going to
           * be sent - the box lying about what it is holding, one level up. */
          if (name) wired[k][name] = { params: spec.params || null,
                                       options: spec.options || null,
                                       only: spec.only || null,
                                       takes: Object.keys(spec.inputs || {}),
                                       defaults: spec.defaults || {} };
        }
      }
      return json(res, 200, { ok: true, key: keyNow() ? "set" : "MISSING", wired });
    }
    return await serveStatic(res, url.pathname);
  } catch (err) {
    console.error(err);
    json(res, 500, { error: String(err && err.message || err) });
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  return await ASKING.run(DEMO ? demoKey(req) : KEY, () => route(req, res, url));
}).listen(PORT, HOST, () => {
  console.log(`\n  Hero's Journey  →  http://127.0.0.1:${PORT}`);
  /* AND A DEMO HAS NO KEY OF ITS OWN TO REPORT, BY DESIGN. Every visitor
   * brings theirs and the process keeps none - so a line about .env here
   * would be an instruction for a machine nobody is sitting at. */
  console.log(DEMO
    ? `  DEMO: a sitting per visitor, and each one brings their own key.\n`
    : KEY
    ? `  key: ${KEY.slice(0, 7)}… (${KEY.length} chars)\n`
    : `  NO KEY YET. Press the key in the top right of the page, or put\n` +
      `  COMFY_API_KEY=... in ${join(HERE, ".env")} and restart.\n`);

  /* THE PAGE OPENS ITSELF, AND IT OPENS FROM HERE RATHER THAN FROM start.bat.
   * The batch file could only launch a browser *before* node, which is a race
   * it loses about as often as it wins - the tab lands on a port nothing is
   * listening to yet and shows a refusal. Inside the listen callback there is
   * nothing to race: the socket is already open.
   *
   * ONLY WHEN ASKED. start.bat sets HJ_OPEN; a server started by hand in a
   * terminal has no business taking over a browser, and `node server.js` in a
   * scratch window should stay a scratch window. */
  /* `npm start` IS THE INSTALL INSTRUCTION, SO IT OPENS THE PAGE. The rule
   * above still holds for a bare `node server.js` in a scratch window - the
   * flag is the ask, and package.json's start script is the one place that
   * asks on somebody's behalf. */
  if (process.env.HJ_OPEN === "1" || process.argv.includes("--open")) {
    const url = `http://127.0.0.1:${PORT}`;
    const open = process.platform === "win32" ? `start "" "${url}"`
      : process.platform === "darwin" ? `open "${url}"`
      : `xdg-open "${url}"`;
    exec(open, (err) => {
      if (err) console.log(`  (no browser opened: ${err.message})\n`);
    });
  }
});
