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
    : `A shot board of one moment. ${Cap(one)} is the scene. `
      + (hasPage
          ? `${Cap(two)} is a blank layout page: fill its panels edge to edge, `
            + "never copy its lines, gutters or labels. "
          /* no page: the only thing left to forbid is the thing a model draws
           * when it is asked for panels - a line between them. */
          : "The panels meet edge to edge, with no line, gutter, border or "
            + "caption drawn between them. ")
      + "Every panel is that same moment from a different camera position. ")
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
      /* AND A BOARD WITH NO PAGE AT ALL - Babe, 2026-10-29, after the labels
       * came off the template and the gutters did not: "we could actually try
       * just prompting the sequence of 6 frames with no borders instead of
       * using the image ref. see what happens".
       * EVERYTHING THE PAGE SAID NOW HAS TO BE SAID. This branch was empty
       * because a board had always had one, so dropping the reference without
       * this would have left the model holding a scene, a list of six
       * framings and nothing about the arrangement they go in. The grid and
       * its count arrive in the prompt from `panelSentence`; what belongs
       * here is what the drawing was FOR - that the panels meet, that no line
       * is drawn between them, and that nothing is lettered. */
      ? (single
          ? ""
          : "The result is one image divided into panels that meet each other "
            + "directly, with no gap, no gutter, no dividing line and no frame "
            + "or outline drawn between them. Around the outside of the whole "
            + "image is a narrow border of pure black, the same width on all "
            + "four sides, and nothing is drawn in it. Each panel is a complete "
            + "cinematic frame of its own, not a crop of its neighbour, and each "
            + "shows the same moment of the same scene from the position the "
            + "words below give it. No words, letters, numbers or captions "
            + "anywhere in the image. ")
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

/* AND WHAT COMES OUT IS NOT ALWAYS A PHOTOGRAPH. These three tails all end
 * "produce one photograph", which is right for this rung's default and is a
 * second director the moment image 2 is a LOOK donor: the clause above it has
 * just said the medium comes from a painting, and the sentence after it asks
 * for a photograph of that. This rail has a name for arguing with yourself in
 * one prompt, and the answer is never to say the quieter thing louder - it is
 * not to say it. `PLACE_SYS` solved the same contradiction on 03 by deferring
 * ("photographic, unless the words below call for another medium"); here the
 * medium has already been named by a picture, so the noun simply stops
 * claiming one. */
const MADE = (v) => (v.ref && !(v.blank || {}).prompt ? "picture" : "photograph");

/* WHAT THE SECOND PICTURE IS FOR, ONCE, 2026-10-31. The same sentence was
 * written out three times - in GUIDE_SYS, CAM_SYS and CUSTOM_SYS - which is
 * one fact drawn three ways and three places to forget when it changes. It
 * changed today.
 * AND IT IS A CHARACTER OR A LOOK, AND THE WORDS SAY WHICH - see STYLE_SYS
 * for the run that named it: a painted portrait handed to "costume, hair and
 * props come from it" is a person to become rather than a handling to
 * borrow, and with the artist's own line beside it that is two answers to
 * one question. No words and the picture is all there is, so it stays what
 * it has always been. */
const REF_CLAUSE = (v, two = "Image 2") =>
  !v.ref
    ? ""
    : (v.blank || {}).prompt
      ? `${two} is the style: costume, headwear, masks, props, hair, grooming, `
        + "lighting and colour grade come from it, and never its face. "
      : `${two} is the look: its medium, palette, brushwork, lighting and `
        + "colour grade come from it and nothing else - never its subject, "
        + "their face, their hair, their clothes, their pose or its "
        + "background. The words below say what they become. ";

/* AND THE JOB IS APPLYING A STYLE, NOT MAKING A CHARACTER - Babe,
 * 2026-10-31: "i think i want to edit what STYLE mode does tho... to sort
 * of make it more general something like 'apply a style reference image to
 * a source image'", and when asked which way: "generic".
 *
 * ALL FOUR OF THIS RUNG'S SENTENCES OPENED "YOU ARE A CHARACTER
 * PHOTOGRAPHER" AND CLOSED ON "THE CHARACTER DESCRIBED BELOW" - and the
 * three in between said "the person in image 1". So the scaffolding
 * asserted three things the artist had not: that the source is a person,
 * that the reference is a character, and that what comes out is a new one.
 * Ask for a hand-painted version of a still life and every clause above the
 * line is still casting somebody.
 *
 * AND `CUSTOM_SYS` HAD ALREADY SOLVED THE HARD HALF. The import path has
 * said "it may be a photograph of a person, a drawing, a character, a figure
 * or an object - do not assume which" since it was written, and then kept
 * the identity conditionally: a face exactly if there is a face, the shape
 * and markings that identify it if there is not. THE LIKENESS NEVER NEEDED
 * THE WORD CHARACTER - it needed the conditional, which is what keeps this
 * rung's whole reason for existing while the job stops presuming a person.
 *
 * SO THE OPENER IS ONE CONSTANT AND IT STATES BABE'S SENTENCE. Written out
 * four times, it was four places to forget - and it changed today, which is
 * the test this file keeps applying to a literal that appears twice. The
 * headline over it is still BECOME SOMEONE, and nothing about that moved:
 * applying a style reference to a photograph of yourself IS how you become
 * someone, and the generalisation widens what that headline covers rather
 * than arguing with it. */
const STYLE_JOB = "You apply the style of one picture to another. ";

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
const GUIDE_SYS = (v) =>
  STYLE_JOB
  + "Image 1 is NOT a person and NOT the subject: it is a grey featureless "
  + "mannequin bust, included only as a framing guide. Take from it the crop, "
  + "the camera angle, the eye level, the camera distance and how much of the "
  + "frame the head fills - nothing else. Never keep its face, its blank "
  + "features, its bald head, its grey material, its surface or its lighting, "
  + "and never return a mannequin, a statue, a bust or a figure. "
  + REF_CLAUSE(v)
  /* AND THE TAIL ASKS FOR WHAT WAS DESCRIBED, not for a human character,
   * 2026-10-31. The bust is a framing guide and the description is the
   * whole subject here, so naming the kind of thing it has to be was the
   * one clause that could refuse the brief outright. If they describe a
   * person it invents a person; if they describe a carved figure, a bird or
   * a mask, it is no longer being told otherwise - and the refusal list
   * above still keeps a mannequin from coming back. */
  + `Produce one ${MADE(v)} of whatever the description below asks for, `
  + "invented from it - its own surfaces, materials and detail - and framed "
  + "the way image 1 is framed. Always return an image.";

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
const CUSTOM_SYS = (v) =>
  STYLE_JOB
  + "Image 1 is the subject. It may be a photograph of a person, a drawing, a "
  + "character, a figure or an object - do not assume which. Whatever makes "
  + "that subject recognisable must survive: if it is a person or a face, keep "
  + "it exactly, including bone structure, eyes, nose, mouth, age and any "
  + "glasses; if it is not, keep the shape, markings and proportions that "
  + "identify it. Keep the crop, the camera angle and the camera distance of "
  + "image 1. "
  /* AND THE POSE, WHICH EVERY SIBLING KEPT AND THIS ONE DID NOT - Babe,
   * 2026-10-31, having typed it by hand into the box: "is the system prompt
   * add keep the pose and camera angle or should i have the agent add it".
   * MEASURED, AND IT WAS HALF THERE. The camera angle is kept by name three
   * clauses up; the only time POSE appeared was about image 2, refusing the
   * REFERENCE's. `CAM_SYS` keeps "the exact same pose and facial expression"
   * in Babe's own words, and all three branches of `STYLE_SYS` keep it too -
   * so the import path was the one of four that did not, and a restyled
   * frame is an import.
   * IT IS A MECHANIC AND NOT A DIRECTION, which is what settles where it
   * belongs: the source on this rung is the framing GUIDE, so what survives
   * it is the server's to state and not something the artist should have to
   * remember typing. */
  + "Keep the exact same pose and facial expression. "
  + REF_CLAUSE(v)
  + `Produce one ${MADE(v)} of that subject, restyled as described below. `
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
const CAM_SYS = (v) =>
  STYLE_JOB
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
  + REF_CLAUSE(v)
  /* THIS BRANCH MAY SAY "THAT PERSON" AND THE OTHERS MAY NOT: the webcam
   * photographed whoever was sitting in front of it, so the provenance is
   * what makes the claim safe. What went is "as the CHARACTER described
   * below" - the description may be a character and may be a treatment, and
   * only the words know. */
  + `The result is a deliberate ${MADE(v)} of that person as the description `
  + "below asks - lit for what it describes, in its own surroundings. "
  + "Always return an image.";

/* AND NOTHING IN THE SLOT AT ALL IS TEXT TO IMAGE - Babe, 2026-10-31: "what
 * happens if you dont use inputs. the models that display are t2i or t2v".
 *
 * EVERY OTHER SENTENCE ON THIS RUNG OPENS ON IMAGE 1. The guide keeps a
 * mannequin's crop, the webcam keeps your face, the import keeps whatever
 * makes a subject recognisable - and all three name a picture that is not in
 * the payload once the source goes, which is the exact bug the `!v.ref` arm
 * was fixed for the same week: a prompt addressing a reference nobody sent.
 * Nano's is worse, because with no `sys` composed its GRAPH answers, and
 * that one opens "You are given two images".
 *
 * SO THE SCAFFOLDING STOPS HAVING A SUBJECT TO KEEP. There is no face to
 * survive, no crop to inherit and no pose to hold: the character IS the
 * sentence, and the only thing left to say is what this rung has always been
 * about - a portrait, framed the way 01 frames one, of somebody who does not
 * exist yet.
 *
 * AND THE FRAMING IS SAID OUT LOUD HERE, because the source was the thing
 * saying it. "A headshot has to be asked for twice" is this rung's oldest
 * lesson - name the crop AND the exclusion - and with no guide in the payload
 * nothing else is going to ask.
 *
 * THE REFERENCE STILL WORKS AND STILL SPLITS THE SAME WAY. `REF_CLAUSE` is
 * the one sentence here that was never about image 1, so a style donor on a
 * t2i run means what it always meant and the words still decide whether it is
 * a character or a look. */
/* AND THE ONE PICTURE A T2I RUN CAN STILL HAVE IS THE REFERENCE, WHICH
 * `fillWhenEmpty` HAS JUST MADE IMAGE 1. So it is read off `source` here
 * rather than off `ref`: by the time this composes, the promotion has
 * happened and the donor key is gone, which is what keeps the sentence and
 * the wiring describing the same job. `blank.source` is what says the
 * picture in that slot is a reference rather than a subject - it records
 * what ARRIVED empty, and the promotion runs after it. */
/* AND IT SAYS ALMOST NOTHING, WHICH IS BABE'S CALL - 2026-10-31: "it
 * makes sense for there to not be much system prompting in text to image
 * also in case people want to just explore character or styled images",
 * then "i would say its up more to the agent to dial it into something
 * specific that works with the model".
 *
 * THE FIRST DRAFT WAS A PORTRAIT STUDIO WITH NO WAY OUT. It opened "you
 * are a character photographer", said the character was to be invented
 * with their own face, hair, skin and build, and closed by asking for the
 * collarbone crop, the head filling the frame and an 85mm lens. Every one
 * of those is this rung's DEFAULT rather than its mechanics - and on a
 * panel with nothing in it the artist's line is the whole brief, so a
 * scaffolding that names a subject, a crop and a lens is three directors
 * talking over it. Ask for a flat graphic, a wide landscape, a product on
 * a seamless ground, and the sentence above it is still asking for a
 * headshot of a person.
 *
 * AND THE FRAMING WAS ONLY EVER SAID TWICE BECAUSE A PICTURE WAS SAYING
 * IT FIRST. "A headshot has to be asked for twice" is this rung's oldest
 * lesson and it is a lesson about a GUIDE: name the crop and the
 * exclusion, because the source photograph is already holding both. With
 * no guide in the payload there is no first asking to reinforce - there is
 * only an instruction, and an instruction nobody asked for.
 *
 * SO THE CRAFT MOVES ONE LAYER UP, TO THE PLACE THAT CAN BE SPECIFIC
 * SAFELY. The server knows the MECHANICS and always applies them; the
 * agent knows the JOB and the MODEL, reads what was actually asked for,
 * and proposes a line in a box the artist edits before RUN. A crop in the
 * scaffolding is unarguable; a crop in the proposal is a suggestion you
 * can delete. `voiceFor` is already last in `AGENT_SYS` for exactly this
 * reason - see `AGENT_JOB.style`, which now knows when there is no
 * photograph.
 *
 * WHAT IS LEFT IS THE FOUR THINGS ONLY THIS LAYER KNOWS: that there is no
 * subject to keep (because nano's own graph prompt opens "You are given
 * two images" and answers when no `sys` is composed), what the one
 * picture is for if there is one, what medium the noun may claim, and
 * that Gemini has to be told to return a picture at all. */
/* AND THE ONE PICTURE A T2I RUN CAN STILL HAVE IS THE REFERENCE, WHICH
 * `fillWhenEmpty` HAS JUST MADE IMAGE 1, so it is read off `source`. */
const T2I_SYS = (v, one = "image 1") => {
  const lifted = { ...v, ref: v.source };
  return "There is no photograph of a subject to work from and nothing to "
    + "keep: the description below is the whole brief, and it decides what "
    + "is in the picture and how it is framed. "
    + (v.source
        ? `The only image you are given is ${one}, and it is NOT the subject `
          + "and NOT a person to reproduce. "
        : "")
    + REF_CLAUSE(lifted, one.charAt(0).toUpperCase() + one.slice(1))
    + `Produce one ${MADE(lifted)}. Always return an image.`;
};

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
  /* AND WITH NOTHING IN THE PANEL THE APPEARANCE IS THE AGENT'S TO WRITE,
   * 2026-10-31 - Babe, on cutting the text-to-image scaffolding back: "i
   * would say its up more to the agent to dial it into something specific
   * that works with the model".
   * BOTH HALVES OF THIS JOB WERE FALSE ON AN EMPTY PANEL. "Their own
   * photograph is the subject" names a picture that is not in the payload,
   * and "never describe their face, age, build or likeness: those come from
   * their photograph" forbids the only thing a text-to-image run can do -
   * which is the same sentence, and the same mistake, that `H3_I2V_SYS`
   * made one rung over when the first frame went away.
   * SO IT SPLITS ON THE PICTURE RATHER THAN ON THE TAB. `look` is the left
   * slot and it is `dropWhenEmpty`, so its absence IS the empty panel - the
   * same thing `AGENT_SEES` is already gated on two lines down, which is
   * why nothing had to be sent from the page to say so.
   * AND THIS IS WHERE BEING SPECIFIC IS SAFE. The scaffolding applies to
   * every run and cannot be argued with; this is a proposal in a box the
   * artist edits before RUN, and `voiceFor` is appended after it, so the
   * line is dialled in for the row that is actually pressed. What was a
   * crop and a lens in the server's sentence is a craft decision here -
   * and the one thing it is told NOT to assume is that a character is what
   * was asked for at all: "in case people want to just explore character or
   * styled images". */
  style: ({ look }) =>
    look
      /* AND THE JOB IS A STYLE TO APPLY, NOT A CHARACTER TO CAST, 2026-10-31
         - the agent's half of the same generalisation as `STYLE_JOB`. It
         opened "a CHARACTER STYLE" and said the line says what to turn THEM
         into, which is one of the things this tab does rather than the whole
         of it. The picture in front of it may be a person and may not, and
         the face rule survives either way because it is about what is
         already IN the picture rather than about what kind of thing it is. */
      ? "You help someone write one short line describing a STYLE to apply to "
        + "a picture they already have. That picture is the subject and it "
        + "stays the subject: the line you write says how it is remade - "
        + "the medium, the wardrobe, hair, headgear, props and materials, the "
        + "era, the light and the world it belongs to. Never describe the "
        + "subject itself - a face, an age, a build, a likeness, the shape of "
        + "an object: all of it is in their picture already and is not yours "
        + "to change. "
      : "You help someone write one short line for an image made from words "
        + "alone. There is no photograph: nothing is being kept and nothing is "
        + "being changed, so everything in the picture is yours to propose - "
        + "and that now includes the subject themselves, their face, hair and "
        + "build, which on this rung normally arrive in a photograph and are "
        + "never written about. "
        + "WRITE WHAT THEY ASKED FOR AND NOT WHAT THIS RUNG USUALLY MAKES. A "
        + "character is the common case and not the only one: a look, a "
        + "texture, a piece of a world or an object are all legitimate here, "
        + "so take the subject from their own words and never turn something "
        + "else into a portrait of a person. "
        + "DECIDE THE FRAMING, because nothing else will. With no photograph "
        + "there is no crop, no camera distance and no eye level arriving from "
        + "anywhere, and a line that leaves them open gets whatever the model "
        + "defaults to. If they named a framing, keep it in their words; if "
        + "they did not, choose the one their subject wants - a character is "
        + "usually a portrait cropped near the collarbone with the head "
        + "filling the frame, and a place, an object or a graphic is usually "
        + "not - and say it plainly in the prompt. ",
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
  board: ({ panels }) =>
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
  /* AND SEQUENCE IS THE SAME RUNG WITH THE SHOTS ALREADY DECIDED, 2026-10-29.
   * The board's panels are anchored along the clip now, so the moments exist
   * before a word is written and what is open is the TRAVEL between them -
   * which is the opposite of what `motion` asks for, where the shots are the
   * artist's to invent. */
  /* AND IT IS HANDED THE SIX BY NAME, the way the board one rung back is -
   * off the same layout table the template is drawn from. It was not: the
   * reader asked the SLOT for its mode, and 05's tab is keyed `seq` while the
   * layout being cut is 04's `sequence`, so the agent was writing beats for
   * six anonymous moments on the one rung that knows exactly which framing
   * each of them is. A reader asking the wrong key after a rung grew tabs of
   * its own, which is a shape this file has paid for before. */
  shots: ({ panels }) =>
    "You help someone write the MOVEMENT for a clip whose shots are already "
    + "decided. The frames it passes through are fixed - each panel of their "
    + "board is anchored at its own moment in the clip, in order"
    + (panels ? ", and the order is this: " + panels + ". " : ". ")
    + "Never propose different shots, a different number of them or a "
    + "different order. Write what happens BETWEEN them and inside them: what the "
    + "character does, how the camera travels from one framing to the next or "
    + "whether it cuts, and what else moves - cloth, hair, dust, water, light. "
    + "Never describe the person, their wardrobe or the room: those arrive as "
    + "pictures. ",
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
  /* AND THE MOMENTS ARE NOT ARITHMETIC - THEY ARE ALREADY DECIDED. The page
   * cuts the board and places each panel at a frame before anything is
   * submitted, so the exact times exist and this was asking the agent to
   * divide for them: "evenly between" is a sum, and a model asked to divide
   * will sometimes answer. It is the lesson `motion`'s shot ceiling is
   * written around, one tab across - say the number.
   * AND THE TIMES CARRY THE WARNING BY THEMSELVES. Six panels inside five
   * seconds is a beat every 0.8s, under the 1.5s floor this rail uses for a
   * shot everywhere else; handed the real times the agent writes to the clip
   * it is going to get rather than to a comfortable one.
   * `beats` rides along from the page and reaches no node, the way `panels`
   * and `seconds` do. With none - an older page - it falls back to the even
   * division it used to ask for. */
  shots: (v, secs = Number(v.seconds) || 5, beats = String(v.beats || "").trim()) =>
    "The prompt is the plan for a clip whose frames are already anchored: ONE "
    + "beat per panel, in order. "
    + (beats
        ? "The panels land at exactly these moments and no others: " + beats
          + ". Write one beat at each of those times, and do not add one, drop "
          + "one or move one. "
        : "Panel 1 is at the first frame, the last panel at the last and the "
          + "rest evenly between them, across " + secs + " seconds. ")
    + "Write each as `0.0s:` and then what is happening at that moment and "
    + "how the camera got there - `cut to` where it cuts and the move where "
    + "it does not. "
    + "End with one line beginning `AUDIO:` giving the ambience, because this "
    + "model makes its own sound - say `No music.` unless they asked for some. "
    + "Say where the camera goes, never what lens or stock it is on, and "
    + "nothing else: no other headings, no instructions to the model, no "
    + "mention of a reference image. ",
  motion: (v, secs = Number(v.seconds) || 5) =>
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
  change: (v, secs = Number(v.seconds) || 5) =>
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
  /* AND ON SEQUENCE THE PANELS ARE THE MOMENTS, which is the exact opposite
   * of what `motion` has to say. There the board is a look and six panels are
   * emphatically not six shots; here each panel is anchored at its own frame,
   * so they are the shots and the count is the count. The same picture, two
   * jobs, two sentences. */
  shots:
    "You can see the board: the framings this clip passes through, in reading "
    + "order. Each panel is anchored at its own moment in the finished clip - "
    + "the first at the opening frame, the last at the closing one - so they "
    + "ARE the shots and there are exactly as many as you can see. Read what "
    + "each one shows and write the travel between them. ",
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
  /* AND A JOB THAT IS A FUNCTION TAKES THE VALUES TOO, 2026-10-31. It was
     handed `v.panels`, which held while the board was the only job that
     needed to know anything - and `style` now needs to know whether there
     is a photograph at all. One position is the trap this function was
     rewritten to avoid, two lines down and again in `AGENT_SHAPE`. */
  const job = AGENT_JOB[about] || AGENT_JOB.style;
  return (typeof job === "function" ? job(v) : job)
  + (v.look ? (AGENT_SEES[about] || "") : "")
  + "Answer with one JSON object and nothing else - no prose around it, no code "
  + "fence, no markdown - with exactly two keys: "
  + '"say", one or two sentences to the person in plain language, and '
  + '"prompt", the line itself. '
  + "If you have enough to write a line, write it and keep `say` to a sentence "
  + "introducing it. If you genuinely need one more thing to know, ask for that "
  + "one thing and leave `prompt` as an empty string - never ask twice in a row "
  + "and never ask for something they have already told you. "
  /* AND THE SHAPE TAKES THE VALUES TOO. It was handed one position, which
   * held for exactly as long as the length was the only thing a shape needed
   * to know; `shots` needs the anchor times as well, and a second argument
   * is the trap `AGENT_SYS` itself was rewritten to avoid. */
  + (typeof shape === "function" ? shape(v) : shape)
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
const H3_R2V_SYS = (job, hasSheet, slate) =>
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
  + "Every frame of the clip is ONE continuous picture filling the whole "
      + "image: never a grid, never panels, never a split screen, never an "
      + "inset or a border, whatever the references look like. "
      + (job === "shot"
      ? "ONE CONTINUOUS TAKE. The clip does not cut: one camera, one move, "
        + "from the first frame to the last. "
      : job === "seq"
      ? "The direction below is a plan of shots and the cuts it names are the "
        + "cuts the clip makes - no others. "
      : "")
  + (slate === "board"
      ? "<PICTURE 1> IS A CONTACT SHEET, NOT A SHOT LIST. Its panels are ONE "
        + "moment seen from several camera positions, and they are there to "
        + "show you the character, the place, the light and the grade. The "
        + "number of panels is NOT the number of shots - the plan below is the "
        + "only thing that says when to cut, and if it names one shot the clip "
        + "does not cut at all. Never render the panels: no grid, no split "
        + "screen, no inset, no border. Every frame of the clip is one "
        + "continuous picture filling the whole image."
      : "");

/* FLUX 3 MAX ANIMATES KEYFRAMES, WHICH IS THIS RUNG'S TWO JOBS IN ONE NODE -
 * Babe, 2026-10-29: "i think we should add flux 3 video btw", "i guess its
 * partner but thats fine". The node's own description is the whole reason it
 * is here: "Each image becomes a frame of the clip: one image opens it, two
 * become its first and last frame, and more are spread across it or pinned to
 * times you choose." So SINGLE SHOT is one keyframe and SEQUENCE is the six
 * cut panels, passed through in order - the same two machines MINIMAX-H3
 * needed two checkpoints for.
 * AND IT IS ADDRESSED IN PLAIN WORDS. Seedance reads @Image1, H3 reads
 * <Picture 1>, and this node has no tokens at all - it takes one prompt about
 * how the scene should move and sound, and reasons about it before rendering.
 * So the scaffolding names the pictures the way a person would, which is what
 * GENJUTSU already needed on 06.
 * THE NO-GRID CLAUSE IS UNCONDITIONAL HERE, unlike H3's: a keyframe becomes a
 * frame of the clip, so a page of panels handed over whole would be rendered
 * as a page of panels. SEQUENCE never hands one over - the client cuts it -
 * and on the other two tabs this is the only thing standing between a board
 * slate and a contact sheet that moves. */
/* MOSS'S EDIT LINE, WHICH IS ITS LORA'S TRAINING PHRASE WITH THE ARTIST'S
 * HALF LEFT OPEN. The template names the shape outright - "Change only the X
 * to Y. Keep the character, face, hair, pose, background and composition
 * unchanged." - so this says the keeping half and hands over, rather than
 * inventing a register for a model that already has one.
 * AND THE SECOND PICTURE IS NAMED ONLY WHEN THERE IS ONE, the way every
 * two-reference row on this rung does it: the encoder takes image 1 as the
 * thing being edited and image 2 as whatever the instruction points at. */
/* THE TWO CELLS KREA 3's MODES SHARE, because a mode's `defaults` replaces
 * the whole table and the only thing EDIT actually changes is one boolean. */
const KREA_DEF = { ar: "1:1", res: "2K" };

/* AND THE KEEP-LIST MUST NOT NAME THE THING BEING CHANGED - Babe,
 * 2026-10-31, after an edit that came back as a different person in a
 * studio: "i tried edit but its pretty random", "so i think that is not
 * looking at the source / webcam shot".
 * IT WAS LOOKING AT IT AND THE SENTENCE TOLD IT NOT TO. The composed line
 * read "Keep the character, their face, their hair, their pose, the
 * framing, THE BACKGROUND and the composition exactly as they are. Change
 * only this: make it a studio lit room, brighter" - the two-directors trap
 * with both directors inside one sentence, disagreeing about the same
 * noun. Handed that, the model resolved it by dropping the reference and
 * building a picture that satisfies the second half.
 * THE TEMPLATE'S PHRASE IS A SHAPE, NOT A LIST. "Change only the X to Y,
 * keep the rest unchanged" means the keep-list is the COMPLEMENT of the
 * edit - and a fixed one forbids the two jobs an instruction editor is
 * most often asked for, a relight and a new room.
 * SO IT KEEPS THE PERSON AND LETS THE ARTIST DECIDE THE REST. The face is
 * what every later workflow reads off this rung, which is the one thing
 * that must survive whatever is being changed; the background, the light
 * and the composition are the artist's, and they are named by the line
 * underneath rather than forbidden above it.
 * (*) The wiring was never the suspect once it was measured: the dry run
 * drops 40 and 41 cleanly, `vae` is connected on both encoders and
 * `image_strength` is 1. The graph was right and the sentence was not. */
const MOSS_EDIT_LINE = (hasRef) =>
  "Keep the person exactly as they are - the same face, the same hair, the "
  + "same build - and change nothing the instruction does not name"
  + (hasRef
      ? ", and take from the second picture only the thing the instruction "
        + "names - never its face, its framing, its light or its background. "
      : ". ")
  + "Change only this:";

/* AND THE OPENING COUNTS THE PICTURES. It said "the picture" and "it is the
 * clip's own frame" on every job, and two of the three hand this node several
 * - so the sentence introduced one picture and the next clause talked about
 * six. A scaffolding that cannot count what it was given is one more voice
 * disagreeing with the graph. */
const FLUX3_SYS = (job, slate) =>
  (job === "seq" || job === "transition"
    ? "Animate the pictures you have been given. "
      + "They are the clip's own frames: the character, the place, the light "
      + "and the grade are all in them and every one of them carries. "
    : "Animate the picture you have been given. "
      + "It is the clip's own frame: the character, the place, the light and "
      + "the grade are all in it and every one of them carries. ")
  + "Do not describe their "
  + "appearance in words - it is already in front of you - and say what MOVES "
  + "and what it sounds like instead. "
  + (job === "seq"
      ? "The pictures are the shots: they are passed through in order, spread "
        + "evenly across the clip, and the clip travels or cuts between them as "
        + "the plan below says. "
      /* TWO KEYFRAMES ARE THE TWO ENDS, in this node's own words: "one image
       * opens it, two become its first and last frame". So the sentence says
       * which is which and leaves the middle to the direction - the same
       * shape Seedance's and Kling's transitions already use. */
      : job === "transition"
      ? "There are TWO pictures and they are the two ends of the shot: the "
        + "first is the frame it opens on and the second is the frame it ends "
        + "on. Hold the character, the wardrobe, the light and the grade "
        + "exactly as those two frames have them and fill the time between "
        + "them as the direction below says. "
      : "ONE CONTINUOUS TAKE from that opening frame - one camera, one move, "
        + "and no cut unless the direction below asks for one. ")
  + "Give the clip its sound - voice, room, effects, whatever the direction "
  + "calls for. "
  + "Every frame of the clip is ONE continuous picture filling the whole "
  + "image: never a grid, never panels, never a split screen, never an inset "
  + "or a border, whatever the pictures you were given look like."
  + (slate === "board" && job !== "seq" && job !== "transition"
      ? " The picture you have is a contact sheet of one moment seen from "
        + "several camera positions - take the character, the place, the light "
        + "and the grade from it and render the moment itself, never the sheet."
      : "");

/* AND FLUX EDITS A CLIP FROM ONE SENTENCE - Babe: "could also be in the video
 * edit mode". The node says what it keeps, which is nearly everything:
 * "Length, framing, camera motion and audio come from the source clip", and
 * "Anything you do not mention is meant to stay as it was".
 * SO THE SCAFFOLDING IS SHORT, which is this rail's own lesson about edits
 * arriving on a clip: every word spent re-describing what is already in frame
 * is a word an edit model reads as something to preserve, and here the model
 * assumes that by itself. It states the operation, says the rest is the
 * source clip's, and gets out of the way. */
const FLUX_EDIT_SYS = () =>
  "Edit the clip as instructed, and change nothing the instruction does not "
  + "name. The length, the framing, the camera, the performance and the sound "
  + "are the source clip's and stay exactly as they are. Do not describe the "
  + "person, their face or their build - they are already in the footage:";

/* RESOLUTIONSELECTOR TAKES A LABELLED STRING AND THE LABELS ARE NOT
 * GUESSABLE - "2:3 (Portrait)" is refused and "2:3 (Portrait Photo)" is not,
 * which is a trap this rail has already paid for once on the roll. The row
 * carries the bare ratio because that is what a person reads; this is what
 * goes on the wire, and it is a `cast` rather than an `options` list so the
 * cell is not eight strings wide. Verified against `get_node`, which is free. */
/* H3's OWN SECONDS, IN ONE PLACE BECAUSE THREE SPECS READ THEM. `length` is
 * frames at 24fps and the node's tooltip gives the trained range as ~124 to
 * ~362 - 5.2s to 15.1s - so 4 is below the floor and 15 is the top of it.
 * A MODE'S `options` REPLACES THE WHOLE TABLE, the way its `inputs` does, so
 * a mode that changes one cell's list has to restate the other - which is a
 * list written three times unless it is a const. */
const H3_SECS = ["5", "8", "10", "15"];

/* (*) KLING TAKES 3 TO 30 SECONDS, so its list is its own rather than a
 * second reference to H3's: those four values are what the 17-frame block
 * grid rounds cleanly onto, which is a fact about a different model that
 * happens to overlap. Every word of this one is mine. */
const KLING_SECS = ["5", "10", "15", "20"];

/* AND THE CELLS THE THREE MACHINES SHARE, for the same reason: `params` is
 * replaced whole by a mode, so the two that do not take REF would otherwise
 * write the other five out again. */
const H3_CELLS = ["ar", "size", "duration", "steps", "seed"];

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

/* AND THE HALF THAT IS TRUE WHATEVER 04 DREW IS ALWAYS SENT, 2026-10-29 -
 * Babe, on an H3 clip that came back as the board itself, animated: "it
 * created a video but it animated the board itself", "so all the frames have
 * motion".
 * THE PARAGRAPH THAT STOPS THAT SAT ENTIRELY INSIDE `mode === "sequence"`,
 * and the mode had not survived a reload - so a video model was handed a
 * contact sheet with nothing said about it at all.
 * THE TWO HALVES ARE NOT THE SAME CLAIM. "That reference IS a contact sheet,
 * its panels are one moment, the count is not a shot count" is a statement
 * about what arrived, and saying it in front of a single photograph is how a
 * model is told to invent a grid - which is why it was conditional and stays
 * conditional. "Every frame is one continuous picture, never a grid" is true
 * of every clip this rail makes and costs nothing in front of either.
 * SO THE CONDITIONAL HALF EXPLAINS AND THE UNCONDITIONAL HALF FORBIDS, which
 * is the arrangement where losing the mode costs an explanation rather than
 * the whole defence. */
/* THE FRAME IT STARTS ON, 2026-10-29 - Babe: "i think we should figure out
 * how to use H3. multi-ref, image to video". `MiniMaxH3ImageToVideo` takes a
 * `first_frame` and the clip BEGINS as that picture, where the reference node
 * only ever conditioned on one - which is why a board handed to r2v came back
 * smeared through the shot instead of used or ignored.
 * SO THE SENTENCE SAYS WHAT THE MACHINE DOES, and the one thing it must not
 * do is describe the picture back: it IS the first frame, so every word spent
 * on what is in it is a word the model reads as something to change. */
const H3_I2V_SYS = (job) =>
  "The clip opens on the picture provided and moves from there. That picture "
  + "is the first frame: the character, the wardrobe, the place, the light and "
  + "the grade are already in it and every one of them holds. Do not describe "
  + "their appearance in words; move the camera and the subject only as the "
  + "direction says. "
  + (job === "shot"
      ? "ONE CONTINUOUS TAKE. The clip does not cut. "
      : "The direction below is a plan of shots and the cuts it names are the "
        + "cuts the clip makes - no others. ")
  + "Give the clip its sound - voice, room, effects, whatever the direction "
  + "calls for. "
  + "Every frame is one continuous picture filling the whole image: never a "
  + "grid, never panels, never a split screen, never an inset or a border.";

/* AND WITH NOTHING IN THE SLOT IT IS TEXT TO VIDEO - Babe, 2026-10-31,
 * with the Pika card on screen: "there is a pika h3 flex text to video we
 * can add".
 * IT IS THE SAME MACHINE AND NOT A NEW ONE, which the template's own schema
 * says outright: `video_pika_h3_flex_t2v` is the `Image to Video (Pika H3
 * Flex)` subgraph with `first_frame` and `last_frame` left unconnected, on
 * the `fl2va` checkpoint and the `pika_h3_flex_fl2va_v1` adapter - which is
 * exactly what SINGLE SHOT has run since it was wired. `MiniMaxH3ImageToVideo`
 * declares both frames optional, so dropping the loader is the whole of it.
 * No second graph, no second row, and MiniMax's own row gets it for the same
 * reason on the same node.
 * AND THE OPENING SENTENCE HAS TO GO WITH THE PICTURE. `H3_I2V_SYS` begins
 * "The clip opens on the picture provided" and then spends four clauses
 * saying the character, wardrobe, place, light and grade are already in it -
 * every one of them about an image that is no longer in the payload, and the
 * last of them, "do not describe their appearance in words", forbidding the
 * only thing a t2v run can do. */
const H3_T2V_SYS = (job) =>
  "There is no opening picture: build the whole shot from the direction "
  + "below - the character, the wardrobe, the place, the light and the grade "
  + "are all yours to invent, and they hold from the first frame to the last. "
  + (job === "shot"
      ? "ONE CONTINUOUS TAKE. The clip does not cut. "
      : "The direction below is a plan of shots and the cuts it names are the "
        + "cuts the clip makes - no others. ")
  + "Give the clip its sound - voice, room, effects, whatever the direction "
  + "calls for. "
  + "Every frame is one continuous picture filling the whole image: never a "
  + "grid, never panels, never a split screen, never an inset or a border.";

/* AND TWO FRAMES ARE THE SHOT'S TWO ENDS - Babe, 2026-10-30: "for transition
 * we want to wire up a couple of first and last frame workflows", with the
 * Pika fl2va template on screen. `MiniMaxH3ImageToVideo` declares BOTH
 * `first_frame` and `last_frame` optional and we had only ever wired the
 * first, so the machine SINGLE SHOT already runs IS this machine: one more
 * loader and the other end of the shot.
 * AND WHAT IS OPEN IS THE MIDDLE. Both ends are decided by pictures, so a
 * word spent describing either is a word asking for it to be changed - the
 * direction is what HAPPENS on the way, which is the same division every
 * scaffolding on this rail draws between a reference and an instruction. */
const H3_FLF_SYS = () =>
  "The clip opens on the first picture and ends on the second. Both frames "
  + "are given: the character, the wardrobe, the place, the light and the "
  + "grade are already in them and every one of them holds. Do not describe "
  + "their appearance in words - what the direction gives you is what HAPPENS "
  + "between them, and the clip has to arrive at the second frame exactly. "
  + "ONE CONTINUOUS TAKE. The clip does not cut. "
  + "Give the clip its sound - voice, room, effects, whatever the direction "
  + "calls for. "
  + "Every frame is one continuous picture filling the whole image: never a "
  + "grid, never panels, never a split screen, never an inset or a border.";

/* AND THE BOARD IS A TIMELINE, WHICH IS WHAT IT WAS ALWAYS FOR - Babe,
 * 2026-10-29, pointing at the multiframe template: "maybe this one", "for
 * multiframe board?".
 * `MiniMaxH3AddGuide` ANCHORS AN IMAGE AT A FRAME and chains, so the board
 * stops being a picture to copy and becomes the shots themselves: panel 1 at
 * the first frame, panel 6 at the last, the rest spread between them. The
 * grid never reaches the model at all - only its panels do, one at a time, in
 * the place each one happens.
 * SO THERE IS NOTHING TO FORBID HERE. The contact-sheet paragraph exists
 * because a model was being shown a grid; this one never sees one. */
const H3_BOARD_SYS = () =>
  "The clip passes through the frames provided, in order: each one is a "
  + "moment the camera really arrives at, at the point in the clip it is "
  + "anchored to. They are the same character in the same place on the same "
  + "day, so the wardrobe, the light and the grade hold across all of them "
  + "and every one of them already has what it needs - do not describe their "
  + "appearance in words. Move between them as the direction says: cut where "
  + "it names a cut and move the camera where it does not. "
  + "Give the clip its sound - voice, room, effects, whatever the direction "
  + "calls for. "
  + "Every frame is one continuous picture filling the whole image: never a "
  + "grid, never panels, never a split screen, never an inset or a border.";

const SHOOT_SYS = (job, slate) =>
  "Shoot this from the reference frame. Hold the character, the wardrobe and "
  + "the lighting exactly as the reference has them and do not describe their "
  + "appearance in words; move the camera and the subject, and cut between "
  + "shots, only as the direction says. One continuous take unless it asks for "
  + "a cut. "
  + "Every frame of the clip is ONE continuous picture filling the whole "
      + "image: never a grid, never panels, never a split screen, never an "
      + "inset or a border, whatever the references look like. "
      + (job === "shot"
      ? "ONE CONTINUOUS TAKE. The clip does not cut: one camera, one move, "
        + "from the first frame to the last. "
      : job === "seq"
      ? "The direction below is a plan of shots and the cuts it names are the "
        + "cuts the clip makes - no others. "
      : "")
  + (slate === "board"
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
/* A RESHOOT DOES NOT NEED A CHARACTER - Babe, 2026-10-31, with a clip in the
 * slot, Pika pressed and `NEEDS CHARACTER` under the bar: "im trying reshoot
 * with a clip and pika", "shouldnt need all references for that workflow i
 * dont think".
 * THEY ARE RIGHT AND THE NODE AGREES: `ref_images` is `min_slots: 0` - "no
 * slot is required, so the whole list may be omitted" - so a clip and a
 * direction is a real job. It is the rung's own tab copy, too: RESHOOT
 * "builds a NEW shot around the movement in your clip", and nothing in that
 * sentence says whose shot.
 * SO THE CHARACTER IS AN ANSWER AND NOT A REQUIREMENT, which is what
 * `dropWhenEmpty` has always been for - the place beside it has worked that
 * way since the mode was built. What a reshoot genuinely cannot do without is
 * the clip, because the movement is the whole of what it keeps.
 * AND SWAP KEEPS IT, by restating `required` in its own entry: replacing the
 * performer with nobody is not a job, and a mode that would refuse anyway
 * should refuse where you can see it rather than at Comfy.
 * AND THE SENTENCE BRANCHES, OR IT NAMES A PICTURE THAT WAS NEVER SENT -
 * this rail's oldest failure, and the reason `drops` is computed before
 * `sys`. With no character the paragraph stops addressing one at all and the
 * job becomes what it actually is: keep this movement, build everything else
 * from the direction. */
/* ---------------------------------------------------- KLING 4.0, 2026-10-31
 * Babe, with the four cards on screen: "kling 4 is new btw. we should prob
 * add that as well".
 *
 * FOUR TEMPLATES, FOUR NODE CLASSES, AND THEY LAND ON BOTH CLIP RUNGS.
 * `Kling4ImageToVideoNode` takes up to TEN keyframes - a first, up to eight
 * evenly spaced middles and a last - which is 05's three tabs in one node:
 * SINGLE SHOT is the first alone, TRANSITION is first and last, SEQUENCE is
 * the board's six panels in order. `Kling4TextToVideoNode` is that rung with
 * nothing in the slot. `Kling4ReferenceToVideoNode` takes images AND videos,
 * which is 06's RESHOOT and SWAP, and `Kling4EditVideoNode` is 06's EDIT and
 * keeps the source length.
 *
 * AND EVERY ONE OF THEM READS @Image1 / @Video1, which each node's own
 * tooltip states - the same convention Seedance uses and this server has
 * spoken since 06 was built. So the sentences below are written in a register
 * this rail already has, and the ADDRESSES were read off the templates' own
 * workflow JSON rather than off the catalogue: get_node reports an auto-grow
 * list by its first slot and was wrong about Krea's, which cost a paid
 * refusal.
 *
 * THE RESOLUTION LIST IS 720p / 1080p AND NOTHING ELSE - no 480p, which the
 * rows beside it offer - and the image node has NO aspect ratio at all,
 * because it takes its shape from the first keyframe. Both are `options` on
 * the row, which is what that field is for. */

/* A FIRST FRAME AND ONE TAKE. The picture is already lit and dressed, so the
 * words are for what MOVES - the same division every scaffolding here draws
 * between a reference and an instruction. */
const KLING_SHOT_SYS = () =>
  "@Image1 is the first frame of the clip and the shot opens on it: the "
  + "character, the wardrobe, the place, the light and the grade are already "
  + "in it and every one of them holds. Do not describe their appearance in "
  + "words; move the camera and the subject only as the direction says. "
  + "ONE CONTINUOUS TAKE - the clip does not cut. "
  + "Every frame is one continuous picture filling the whole image: never a "
  + "grid, never panels, never a split screen, never an inset or a border.";

/* AND WITH NOTHING IN THE SLOT IT IS THE OTHER NODE. Nothing is given, so the
 * only thing left to say is that all of it is the direction's. */
const KLING_T2V_SYS = () =>
  "There is no opening picture: build the whole shot from the direction "
  + "below - the character, the wardrobe, the place, the light and the grade "
  + "are all yours to invent, and they hold from the first frame to the last. "
  + "ONE CONTINUOUS TAKE - the clip does not cut. "
  + "Every frame is one continuous picture filling the whole image: never a "
  + "grid, never panels, never a split screen, never an inset or a border.";

/* TWO ENDS, AND WHAT IS OPEN IS THE MIDDLE - H3_FLF_SYS's own argument, said
 * in this node's tokens. */
const KLING_FLF_SYS = () =>
  "@Image1 is the first frame and @Image2 is the last: the clip opens on one "
  + "and ends on the other, and both are already lit, dressed and graded. "
  + "Do not describe either in words - the direction below is what HAPPENS "
  + "between them. "
  + "Every frame is one continuous picture filling the whole image: never a "
  + "grid, never panels, never a split screen, never an inset or a border.";

/* THE KEYFRAMES ARE THE SHOTS, WHICH IS WHAT THE NODE IS FOR. It spaces the
 * middles evenly by itself, so unlike H3 there is no frame to compute - and
 * unlike every other SEQUENCE row the panels arrive as SEPARATE PICTURES
 * rather than as a page, so the clause forbidding a rendered grid is about
 * the OUTPUT alone and the model is never shown one. */
const KLING_SEQ_SYS = (n) =>
  "The " + (n || 6) + " images are the clip's keyframes in order, evenly "
  + "spaced from its first frame to its last: @Image1 opens it and the last "
  + "one ends it. They are one moment covered from several positions - the "
  + "same character, the same place, the same light - so hold all of that "
  + "across the whole clip and cut between them as the direction says. Do not "
  + "describe their appearance in words. "
  + "Every frame is one continuous picture filling the whole image: never a "
  + "grid, never panels, never a split screen, never an inset or a border.";

/* 06's TWO JOBS ON ONE NODE, and the division is the one this rung has drawn
 * since it was built: a reshoot regenerates the frame around the movement, a
 * swap leaves the footage standing and changes who is in it.
 *
 * AND THE NEGATIVE IS THE HALF THAT HAS TO BE SAID. Both guides Babe brought
 * say it and this rail has paid for it twice: a reference video alone
 * reinvents the face and the wardrobe on every run, so the sentence says what
 * to take from the clip and, by name, what not to.
 *
 * AND WHICH PICTURE IS @Image1 DEPENDS ON WHAT ARRIVED, which is the same
 * numbering trap 01 pays `fillWhenEmpty` for: the graph wires the character to
 * image_1 and the place to image_2, so a reshoot with a place and no character
 * would leave one picture in the SECOND slot and a sentence calling it
 * @Image2. The place is promoted into the first address when the character is
 * missing, and `blank.ref1` is what says the picture standing there is a place
 * rather than somebody to become. */
/* THE PICTURES ARE NUMBERED BY WHAT ARRIVED, NOT BY WHICH CELL THEY CAME
 * FROM. `fillWhenEmpty` compacts them upward, so the character, the place and
 * the prop keep their order and lose their gaps - and `blank` is taken before
 * that happens, which is what lets this read the ORIGINAL identity of each
 * one. Three cells is where the `lifted` / `placeAt` pair stopped scaling:
 * two pictures have two arrangements and three have eight. */
const KLING_R2V_SYS = (v) => {
  const blank = v.blank || {};
  const order = [];
  if (!blank.ref1) order.push("char");
  if (!blank.ref2) order.push("place");
  if (!blank.audio) order.push("prop");
  const at = (k) => "@Image" + (order.indexOf(k) + 1);
  const hasChar = order.indexOf("char") !== -1;
  const hasPlace = order.indexOf("place") !== -1;
  const hasProp = order.indexOf("prop") !== -1;
  if (String(v.mode).toUpperCase() === "SWAP")
    return "Replace the performer in @Video1 with the character in @Image1, "
      + "holding their face, build and wardrobe exactly. There is ONE of them "
      + "in the shot. Keep everything else in @Video1 as it is: the same room, "
      + "the same framing, the same camera path, the same light and grade, the "
      + "same timing, and the same things in their hands. Change the person "
      + "and nothing else.";
  return "Build a new shot that keeps the movement, the camera path, the "
    + "pacing and the gestures of @Video1 exactly. "
    + "Do NOT copy the performer, their clothing, the room or the lighting "
    + "from @Video1 - those come from the direction below"
    + (hasChar || hasPlace ? " and from the reference images. " : ". ")
    + "The video gives the gesture and never the thing being held: if the "
    + "direction names what is in their hands, that is what is rendered. "
    + (hasChar
        ? at("char") + " is the character: take their face, build and wardrobe "
          + "from it, and there is ONE of them in the shot. "
        : "")
    + (hasPlace
        ? at("place") + " is the place: take its location, its grade and the "
          + "direction and quality of its light as the look of the whole clip. "
        : "")
    /* AND THE PROP IS THE OTHER HALF OF THE HANDS CLAUSE. The sentence above
     * already refuses the objects in the performer's hands and says the
     * direction supplies what is held; until this cell there was no way to
     * supply a PICTURE of it, only a description. It is named, like every
     * other reference here, because an unnamed extra picture is one the
     * model averages into the others - which is what MISC was and why it
     * went. */
    + (hasProp
        ? at("prop") + " is the object they are holding or using: take the "
          + "thing itself from it and nothing else - not its background, not "
          + "its lighting, not its scale. "
        : "")
    + "Every frame is one continuous picture filling the whole image: never a "
    + "grid, never panels, never a split screen, never an inset or a border.";
};

/* AND AN EDIT KEEPS THE SOURCE PIXELS, which the node says in its own words -
 * "the result has the same length as the input video" - so there is no
 * duration to set and nothing to invent but the one thing named. */
const KLING_EDIT_SYS = () =>
  "Edit @Video1. Change only what the direction below names and keep "
  + "everything else in it exactly as it is: the same performer, their face "
  + "and wardrobe, the same framing, the same room, the same camera work, the "
  + "same light and grade, the same shot count and the same timing. "
  + "An object in shot stays that object unless the direction says otherwise. "
  + "No speech or dialogue unless the direction below asks for it.";

const MOTION_SYS = (v) => {
  const mode = v.mode, hasPlace = !!v.ref2, hasAudio = !!v.audio,
        hasChar = !!v.ref1;
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
  return (hasChar
      ? "@Image1 defines the character - ONE person, and if it is several "
        + "panels they are all that same person: their face, hair, build and "
        + "wardrobe. "
      : "")
    + (hasPlace
        ? "@Image2 defines the setting and the look: the place, its grade, "
          + "and the direction and quality of its light. "
        : "")
    + "@Video1 provides the motion, the camera path, the framing and the "
    + "pacing. "
    + (hasChar
        ? "Transfer the exact movement and timing from @Video1 onto the "
          + "character in @Image1, preserving their identity and clothing. "
        : "Keep that movement and timing exactly and build everything else "
          + "in the shot from the direction below. ")
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
    + "there."
    /* AND THE FOURTH REFERENCE IS NAMED BY ITS ROLE, BECAUSE NOTHING NAMES
       ITS SUBJECT. Babe asked for a MISC cell - "another character, prop,
       etc" - and a reference with no stated job is one the model averages
       into the others, which is what cost 01 a face. 01's EDIT answered the
       same problem the same way: its second picture is "the thing the
       instruction refers to, a jacket or a hat", with its face, framing,
       light and background refused by name. SO THE SENTENCE NAMES WHAT TO
       TAKE FROM IT - whatever the direction asks for - AND REFUSES THE
       REST, and the picture can be of anything without this having to know
       which. */
    + (hasAudio
        ? " @Audio1 is a sound reference: use it for what is HEARD - the "
          + "voice and its delivery, the music, the room tone - and take "
          + "nothing visual from it. If the direction says what is heard or "
          + "when a line is spoken, that is what this is for; if it does "
          + "not, let @Audio1 set the sound of the shot and change nothing "
          + "else about it."
        : "");
};

/* MINIMAX H3, which addresses references as "Image 1" / "Video 1" in
 * connection order, and whose guide asks for the roles twice. */
const H3_SYS = (v) => {
  const hasPlace = !!v.ref2, hasChar = !!v.ref1;
  return (hasChar
    ? "Image 1 defines the character: their face, hair, build and wardrobe. "
    : "")
  + (hasPlace
      ? "Image 2 defines the location and the light: the place, its grade, "
        + "and the direction and quality of its lighting. "
      : "")
  + "Video 1 provides the motion, the camera behaviour, the pacing and the "
  + "timing. "
  + (hasChar
      ? "Use Image 1 for identity and clothing, "
        + (hasPlace ? "Image 2 for location, " : "")
        + "and Video 1 for motion, camera and pacing. Transfer the movement "
        + "and timing from Video 1 to the character in Image 1 while "
        + "preserving their identity and clothing. "
      : (hasPlace ? "Use Image 2 for location and Video 1 for motion, camera "
                    + "and pacing. "
                  : "Use Video 1 for motion, camera and pacing. ")
        + "Keep that movement and timing exactly and build everything else "
        + "in the shot from the direction below. ")
  + "Do not copy the person, the clothing or the "
  + (hasPlace ? "location" : "studio") + " from Video 1."; };

/* AND WITH NO SOUND REFERENCE IT IS A NEGATIVE, NOT AN ASK - Babe,
 * 2026-10-31, after an edit that removed a pair of glasses perfectly and
 * came back talking: "yeah, its adding random audio", then "so yeah i would
 * remove the audio prompting from the system prompt".
 * THE ASK WAS "give the clip its own sound to match what you have made",
 * which on an audio-native model with a face in frame is close to a request
 * for dialogue - and the clip's own sound never reaches it, because
 * `GetVideoComponents` has only its frames wired and EDIT drops the audio
 * reference besides. So it was told to make sound, given none to go on, and
 * shown a moving mouth.
 * REMOVING THE SENTENCE IS NOT ENOUGH ON ITS OWN. H3 writes picture and
 * sound in the same forward pass, so with nothing said it still makes
 * something and still picks - which is this file's oldest lesson, say both
 * halves or the model picks one, and it has cost this rail a clip and a
 * prop already. The ask goes and a negative stands in its place: ambience
 * and effects are the model's, a VOICE is the artist's. */
const NO_VOICE = "No speech or dialogue unless the direction below asks for it.";

/* AND THE SOUND IS A REFERENCE OR IT IS INVENTED, NEVER BOTH - Babe,
 * 2026-10-31: "for pika h3 can we make the 4th reference work?". The tail of
 * both sentences below has always read "give the clip its own sound", which
 * is right with nothing attached and is a SECOND DIRECTOR the moment an
 * <Audio 1> is: one clause asking the model to invent what the other has just
 * handed it. The two-directors trap arriving on the one input that had never
 * had a sentence.
 * AND A REFERENCE WITH NO STATED JOB IS ONE THE MODEL IS FREE TO AVERAGE INTO
 * THE OTHERS, which is this rail's oldest lesson and the reason MISC was cut
 * from a fourth PICTURE to a sound: the one run that cell ever got came back
 * with the liquid recoloured and not the flask. So the clause says what the
 * sound IS FOR and nothing about what it should contain - which is the
 * artist's, like the cuts.
 * THE TAG IS THE NODE'S OWN: "<Picture i> / <Video k> / <Audio j> reference
 * conditioning for MiniMax H3. Use the same tags when prompting." And it only
 * reaches the model at all because `audio_vae` is wired - without it, the
 * node says, reference audio conditions the text encoder and nothing else. */
const AUDIO_CLAUSE = (hasAudio) => hasAudio
  ? "<Audio 1> is the sound of this shot: take the voice, music or "
    + "atmosphere it carries as the clip's own audio rather than inventing "
    + "one, and fit what happens on screen to it."
  : NO_VOICE;


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
const H3_R2V_MOVE_SYS = (v) => {
  const hasPlace = !!v.ref2, hasAudio = !!v.audio, hasChar = !!v.ref1;
  return (hasChar
    ? "<Picture 1> defines the character: their face, hair, build and "
      + "wardrobe. "
    : "")
  + (hasPlace
      ? "<Picture 2> defines the location and the light: the place, its "
        + "grade, and the direction and quality of its lighting. "
      : "")
  + "<Video 1> provides the motion, the camera behaviour, the pacing and the "
  + "timing. "
  + (hasChar
      ? "Use <Picture 1> for identity and clothing, "
        + (hasPlace ? "<Picture 2> for location, " : "")
        + "and <Video 1> for motion, camera and pacing. Transfer the movement "
        + "and timing from <Video 1> to the character in <Picture 1> while "
        + "preserving their identity and clothing. "
      : (hasPlace ? "Use <Picture 2> for location and <Video 1> for motion, "
                    + "camera and pacing. "
                  : "Use <Video 1> for motion, camera and pacing. ")
        + "Keep that movement and timing exactly and build everything else "
        + "in the shot from the direction below. ")
  + "Do not copy the person, the clothing, the "
  + "objects in their hands or the "
  + (hasPlace ? "location" : "studio") + " from <Video 1>. <Video 1> supplies "
  + "the gesture, never the thing being held: if the direction names what is "
  + "in their hands, render that and not what the video shows there. "
  + AUDIO_CLAUSE(hasAudio);
};

/* AND THE SAME WEIGHTS DO A SWAP, WHICH IS A SENTENCE AND NOT A TASK TYPE.
 * Babe, 2026-10-30, with another entry's app on screen: "i think pika h3
 * handles swap too, someone used it in their project" - akatz's OpenCast
 * Studio, which ships Pika H3 Flex doing "the swap or motion transfer", one
 * model behind both.
 * I HAD PINNED THIS ROW TO RESHOOT FOR THE WRONG REASON, which is yesterday's
 * lesson arriving one rung later: `reference` is the only TASK these weights
 * perform, so I read that as the only JOB. It is not. On Seedance the two
 * modes already share one task type - the mode is the job and the task type
 * is the machine, which is what `modes` has always been for - and here there
 * is no task type at all, so what makes a swap a swap is this paragraph.
 * ASK WHAT A MODEL DOES, NOT WHAT ITS TASK LIST IS CALLED.
 *
 * NO PLACE BRANCH, because SWAP drops it. The clip's own room standing IS the
 * difference from a reshoot - the base spec's SWAP has dropped node 3 for
 * exactly this reason since the mode was built, and the open rows drop 139.
 * So there is no <Picture 2> to name and nothing to say about it.
 * AND THE HANDS CLAUSE TRAVELS, because it cost a run to learn and it is
 * true of both jobs: the video says how a hand moves, the direction says what
 * it holds. A rule written for one sentence does not reach the other one. */
const H3_SWAP_SYS = (hasAudio) =>
  "<Picture 1> defines the character: ONE person, and if it is several panels "
  + "they are all that same person - their face, hair, build and wardrobe. "
  + "<Video 1> is the shot they step into. Replace the performer in "
  + "<Video 1> with the character in <Picture 1>, holding the face, build and "
  + "wardrobe of <Picture 1> exactly. Keep everything else in <Video 1> as it "
  + "is: the same room, the same framing, the same camera path, the same "
  + "light and grade, the same timing. Change the person and nothing else. "
  + "Do not copy the performer or their clothing from <Video 1>, and do not "
  + "take the ground, the flat key or the lack of grade from <Picture 1> - "
  + "those are the sheet's, not the shot's. <Video 1> supplies the gesture, "
  + "never the thing being held: if the direction names what is in their "
  + "hands, render that and not what the video shows there. "
  + AUDIO_CLAUSE(hasAudio);

/* LTX 2.3 IC-LORA UNION CONTROL - the open row 06 was missing, recovered
 * 2026-10-31. Babe, with the template on screen: "we should try to add this
 * LTX workflow to 06... i guess as an EDIT workflow?", then the correction
 * that settled where it goes: "i think the model can determine the slots
 * tho. we just need to to be categorized in a mode. so if it is reshoot,
 * which is for motion transfer style workflows, then that is where it
 * should go".
 * IT IS NOT AN EDIT BY THIS RAIL'S OWN DEFINITION - edit keeps every source
 * pixel and changes one named thing, and this regenerates all of them from a
 * depth map. What it keeps is the STRUCTURE, which is RESHOOT's job said
 * exactly: a new shot built around the clip's movement.
 * AND IT IS A BETTER RESHOOT THAN THE TWO BESIDE IT. Pika and H3 take the
 * clip as a loose reference and reinvent the framing; MoGe depth pins this
 * one to the source frame by frame, so the performance, the framing and the
 * motion survive and only the look changes.
 *
 * THE PROMPT IS `129:211.on_false` AND THAT IS NOT A DETAIL. The subgraph
 * feeds a `TextGenerateLTX2Prompt` upsampler into a `ComfySwitchNode` whose
 * `switch` ships FALSE, so the branch that runs is `on_false` - the demo's
 * own jungle-ruin paragraph. Writing the artist's line to `129:209.prompt`
 * succeeds and returns the template's demo art. THIS FILE PAID FOR THAT ONCE
 * ALREADY on `image_qwen_image_2_1_turbo_t2i`; it is the same node class and
 * the same trap, and the address is the only thing that tells them apart.
 *
 * AND THE LENGTH IS THE TRIM, NOT A DURATION FIELD. `129:694 GetImageSize`
 * reads the DEPTH frames and feeds the latent's `length`, so how many
 * seconds of the control video you slice IS how long the clip is - which is
 * the honest shape for a control workflow and the reason there is no
 * separate duration anywhere in the graph.
 *
 * AND IT WRITES ITS OWN SOUND: the subgraph carries an audio latent, an
 * audio VAE and a `CreateVideo` with the audio wired in.
 *
 * AND THE BAKED NEGATIVE WAS THE DEMO'S OWN SHOT NOTES, replaced 2026-10-31
 * while Babe was mid-run. 1,374 characters at `129:112` naming a cap that
 * reads "PNTR", a "JUST DO IT" t-shirt, a microphone, a door and shelves -
 * none of it anything to do with the clip anybody here is shooting.
 * AND IT FORBADE THE JOB. `motion blur` on a rung whose whole input is
 * movement, and `cartoonish rendering`, `stylized filters`, `unrealistic
 * materials` and `3D CGI look` on a rung whose whole output is a restyle:
 * Babe asked for an animated oil painting against a negative telling the
 * model not to make one.
 * IT IS THE `ComfySwitchNode` TRAP'S SIBLING - a template carrying the
 * demo's CONTENT somewhere that looks like configuration, and recovering
 * the graph verbatim is right for the structure and wrong for that widget.
 * What is left is the genuine failure modes and this rail's own refusals: no
 * grid, no panels, no split screen, no inset. */
const LTX23_CONTROL_SYS = () =>
  "The first image is frame one of the clip and it sets the look: its "
  + "medium, palette, lighting, grade and everything in frame come from it. "
  + "The control video supplies the geometry and the movement only - the "
  + "camera path, the framing, the pacing and the position of everything in "
  + "the shot are taken from it frame by frame, and nothing of how it LOOKS "
  + "is kept: not its performer, their clothing, their face, the room they "
  + "are in, its light or its colour. Hold the look of the first image for "
  + "the whole clip while every frame follows the control. Describe the shot "
  + "below as one continuous take; it is never a grid, panels or a split "
  + "screen. " + NO_VOICE;

/* HIGGSFIELD GENJUTSU - built and wired, not on the row today. Same two
 * references, no mode axis, and billed per output second at 205.5
 * credits/second, which is about 1,240 credits on a six-second clip. */
/* AND THE SAME WEIGHTS DO AN EDIT, WHICH IS A SENTENCE AGAIN - Babe,
 * 2026-10-31: "i feel like you can prob do edits with pika h3".
 * THE EVIDENCE IS THEIR OWN SWAP RUN. Pika held the studio, the floor, the
 * light, the framing and the blocking of the driving clip and changed only
 * who was in it - which IS the edit contract applied to a person. A machine
 * that can hold a room that precisely while replacing its occupant can hold
 * one while changing a named thing in it.
 * AND SEEDANCE ALREADY PROVES THE SHAPE: its SWAP and its EDIT are the SAME
 * `task_type`, differing only by this paragraph. The mode is the job and the
 * task type is the machine - so a model with no task type at all is decided
 * entirely here, which is what put this row on SWAP in the first place.
 * I PINNED IT OFF BOTH ONCE, on the reading that `reference` is the only
 * task these weights perform. That is true and is not the same claim, and it
 * is the second time the correction has come from Babe rather than from the
 * catalogue.
 *
 * IT DROPS BOTH PICTURES, which is EDIT's shape on Seedance too: what is
 * being changed is IN the clip, so a character beside it is a second answer
 * to a question the footage has already answered. The quad says so by
 * itself - `takes` reads the drop and the cells go.
 * (*) UNRUN. What to look at is whether the UNNAMED parts of the frame come
 * back untouched, because that is the whole of what separates this from the
 * reshoot one tab over. */
const H3_EDIT_SYS = () =>
  "<Video 1> is the shot and it is already finished. Change only what the "
  + "direction below names, and keep everything else in <Video 1> exactly as "
  + "it is: the same person, the same face, the same clothing, the same room, "
  + "the same framing, the same camera path, the same light and grade, and "
  + "the same timing. Every frame is the frame it already was apart from the "
  + "one thing being changed - do not restage the shot, do not re-light it, "
  + "do not re-frame it and do not re-cast it. If the direction names "
  + "something that is in their hands, change that and nothing about the hand "
  + "holding it. " + NO_VOICE;

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
/* AND A REFERENCE IS A CHARACTER OR A LOOK, AND THE WORDS SAY WHICH, 2026-10-31.
 * Babe, with their own photograph in SOURCE and a painted portrait of a woman in
 * REFERENCE: "trying to get the old man to look like the painting style of the
 * woman but it just rendered the woman."
 * IT DID WHAT IT WAS TOLD. The composed line read "restyle the person in
 * <ref_image_0> as THE CHARACTER in <ref_image_1>", which asks for the woman in
 * so many words - and the agent's line underneath described her portrait again,
 * so the model had three votes for her and one clause for his face. This rail
 * has a name for that: one answer per question, and a reference with no stated
 * job is one the model is free to average into the others.
 * THE SENTENCE WAS WRITTEN FOR RANDOM AND RANDOM IS THE OTHER JOB. That roll
 * makes a whole figure - "a deep-sea diver in a brass helmet, claymation" - and
 * taking its costume, hair and props IS the point: wrapping something strange
 * onto your own silhouette. A painted portrait handed to the same sentence is a
 * person to become rather than a handling to borrow.
 * SO THE ARTIST'S LINE IS WHAT TELLS THEM APART, and this is not a guess about
 * intent: with words there were already TWO answers to what-to-become in one
 * job, which is incoherent whichever one was meant. Words say what to become, so
 * the picture beside them is a LOOK - its medium, palette, brushwork, lighting
 * and treatment, and never its subject. No words and the picture is all there
 * is, so it is the character, exactly as it has been.
 * (*) THE COST IS THAT THE COSTUME NO LONGER TRAVELS ONCE YOU TYPE, which is
 * Babe's to weigh: type "a deep sea diver" over a claymation roll and you get a
 * diver IN claymation rather than the roll's own diving suit. */
/* AND IT TAKES THE VALUES RATHER THAN FOUR POSITIONS, which is `AGENT_SYS`'s
 * own rule: it had grown to a fourth argument with two `undefined`
 * placeholders in front of it, and at that point the only thing holding the
 * call together is argument order. */
/* AND IT IS A SUBJECT, NOT A PERSON, 2026-10-31 - the same generalisation
 * as the three nano branches, in the register these rows read. It said
 * "the person in image 1" three times over and "as a new character" in the
 * branch with no reference at all, which is the scaffolding deciding what
 * the artist is making.
 * AND THE IDENTITY IS KEPT CONDITIONALLY, which is `CUSTOM_SYS`'s own
 * construction at a tenth of the length: a face exactly where there is a
 * face. The pose and the framing are kept unconditionally, because those
 * are facts about any picture - and keeping them is what makes this a
 * restyle rather than a new frame. */
const STYLE_SYS = (v, one = "image 1", two = "image 2") =>
  v.ref
    ? !(v.blank || {}).prompt
      ? `Restyle the subject in ${one} in the style of ${two} - its medium, ` +
        `palette, brushwork, lighting and treatment, and nothing else from it: ` +
        `never its subject, their face, their hair, their clothes, their pose ` +
        `or its background. Keep ${one}'s subject, pose and framing exactly - ` +
        `its face and expression too if it has one - and what the words below ` +
        `describe is what it becomes.`
      : `Restyle the subject in ${one} in the style of ${two} - its costume, ` +
        `hair, props, lighting and treatment. Keep ${one}'s subject, pose and ` +
        `framing exactly, and its face and expression too if it has one.`
    : `Restyle the subject in ${one} as the words below describe. Keep its ` +
      `pose and framing exactly, and its face and expression too if it has ` +
      `one:`;

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
       * reason - WHICH IS WHY THIS ROW SAMPLES A LATENT OF ITS OWN. Babe,
       * 2026-10-29, looking at the row with Klein pressed: "i kind of want
       * aspect ratio for the 03 workflows too". Two of this rung's four
       * already had one; the two without are the two that DERIVE their
       * latent from a reference, and only one of those can be given a
       * choice. `EmptyFlux2LatentImage` is that choice - the references
       * still arrive through the conditioning, so the sheet and the place
       * guide a picture whose SHAPE is the row's own rather than the
       * sheet's. It is the same move 04 asked for the same day, and it is
       * now the same graph: `flux3-klein-2ref-latent.json`.
       * THE SIZE SNAPS TO 16, because this family wants both sides a
       * multiple of sixteen and `arSize` rounds to eight.
       * AND THE TURBO STILL HAS NO AR, which is not an oversight: it samples
       * the latent its own encoder derives from the sheet, so there is no
       * empty latent to size and a cell would be a control that does
       * nothing. 01 and 02 keep the plain two-reference graph for reasons of
       * their own - 01 wants a character shaped like the photograph it was
       * given, and 02's preset owns the ratio outright. */
      "FLUX-3-KLEIN": {
        graph: "flux3-klein-2ref-latent.json",
        label: "Find your place",
        sys: (v) => PLACE_LINE(v.lens, !!v.place, "<ref_image_0>", "<ref_image_1>"),
        inputs: {
          sheet: { node: "11", input: "image" },
          place: { node: "12", input: "image" },
          prompt: { node: "100", input: "value" },
          width: { node: "20", input: "width", cast: (v) => Math.round(v / 16) * 16 },
          height: { node: "20", input: "height", cast: (v) => Math.round(v / 16) * 16 },
          steps: { node: "7", input: "steps", cast: Number },
          seed: { node: "7", input: "seed", cast: Number },
        },
        required: ["sheet", "prompt"],
        /* the second loader goes when nobody filled it and the reference
         * slot on the conditioning node goes with it, so the sentence stops
         * naming <ref_image_1> in the same breath. */
        dropWhenEmpty: { place: ["12"] },
        defaults: { steps: 16, ar: "16:9" },
        params: ["ar", "seed", "steps", "lens"],
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
  /* AND IT ROLLS ON Z-IMAGE-TURBO AS OF 2026-10-31 - Babe: "we may even
   * want that for the randoms instead of qwen", then "i kind of think our
   * random workflow can use z-turbo for cheaper faster results".
   * THIS IS THE ONE GENERATION ON THE APP THAT IS FREE and it runs inside
   * a slot with somebody waiting in front of it, so the thing to spend on
   * here is the clock rather than the look: 8 steps on a 6B model against
   * 8 steps on a 20B. Both are open weights and GPU time only, so cheaper
   * means faster and nothing else.
   * AND THE WHOLE GRAPH HAS NO UPSAMPLER IN IT, which matters more here
   * than anywhere: the roll's sentence IS the randomness - a cast word, a
   * role, a medium, a place - and a model that rewrites it into its own
   * caption first is a model rolling its own dice. `qwen-21-turbo-t2i`
   * carries the `ComfySwitchNode` this repo has been bitten by; this one
   * is a loader, an encode and a sampler.
   * ITS RATIO NODE IS OURS, not the template's. The executed graph sizes
   * an `EmptySD3LatentImage` from two literals, and `rollValues` has sent
   * a ResolutionSelector LABEL since the roll was built - so the node goes
   * in rather than the client learning a second vocabulary. The old row is
   * one line away in `variants` and `qwen-21-turbo-t2i.json` is untouched. */
  random: {
    graph: "z-image-turbo-t2i.json",
    model: "Z-IMAGE-TURBO",
    label: "Random character",
    inputs: {
      prompt: { node: "57:27", input: "text" },
      ar: { node: "19", input: "aspect_ratio" },
      seed: { node: "57:3", input: "seed", cast: Number },
      steps: { node: "57:3", input: "steps", cast: Number },
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
    /* AND THE SOURCE IS NOT REQUIRED, 2026-10-31 - Babe: "what happens if
     * you dont use inputs. the models that display are t2i or t2v".
     * GEMINI GENERATES FROM TEXT. The reference images are optional on this
     * node, so dropping 470 leaves a plain text-to-image job rather than a
     * broken one - no new graph, and nothing about the row changes but what
     * it insists on being given. EDIT restates it below, because an edit
     * with no picture is nothing to edit. */
    required: ["prompt"],
    dropWhenEmpty: { ref: ["475"], source: ["470"] },
    fillWhenEmpty: { source: "ref" },
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
    /* AND THE FALLBACK COMPOSES RATHER THAN RETURNING null, 2026-10-31. A
     * null here means the graph's own `system_prompt` answers, and nano's
     * says "Image 2 is the style: another character" - the CHARACTER reading,
     * baked in, which the words branch cannot reach. It was right while the
     * server and the graph agreed and it stopped being right today.
     * IT WAS ALREADY HALF DONE: the `!v.ref` arm composed `CUSTOM_SYS` for
     * exactly this reason - the graph names an image 2 that is not there -
     * so the two arms were one question asked twice. `CUSTOM_SYS` with no
     * reference composes no reference clause by itself.
     * NOTHING RECORDED IS STILL NOTHING SENT about the SOURCE: this arm is
     * only reachable from a journey written before `src` existed, since
     * `putFile` marks every file that arrives by hand. What changes is that
     * such a journey now gets the generic import sentence instead of the
     * graph's, which is the same sentence it would get today. */
    /* AND THE FIRST QUESTION IS WHETHER THERE IS A PICTURE AT ALL, because
     * all three of the branches below open on image 1 - and nano's GRAPH
     * opens on "You are given two images" whenever none of them composes. */
    sys: (v) => (v.blank.source ? T2I_SYS(v)
               : v.guide ? GUIDE_SYS(v)
               : v.cam ? CAM_SYS(v)
               : CUSTOM_SYS(v)),
    /* THE STYLE SENTENCE LIVES HERE NOW. It was the page's prompt line until
     * 2026-10-25, when that line became a sub-header with a red word in it -
     * so the words moved to the floor under an empty prompt, which is where
     * 02, 03 and 04 already keep theirs. A STYLE run with a picture and no
     * words still goes out saying this; it just stops being said twice. */
    /* AND THE FLOOR NAMES A REFERENCE, so it stands down when there is
     * neither a picture nor a word - that is not a job, and filling
     * `prompt` here would have carried it past `required` and submitted
     * it. With a reference and no words it still means what it always did:
     * become the character in that picture. */
    blankTo: {
      prompt: (v) => (v.blank.source && !v.ref
        ? "" : "Become the character in the reference."),
    },
    /* which cells in the model row mean anything here. Nano has no step
     * count, so showing STEPS beside it would be a lie. Absent = all. */
    params: ["ar", "seed", "res"],
    /* THE SECOND MODE, AND IT INHERITS ALMOST EVERYTHING. This rung is
     * already shaped like an edit - one picture in 470, an optional second in
     * 475 that drops when nobody filled it, a line the artist wrote - so the
     * mode changes the two things that genuinely differ: what the instruction
     * says, and what the refusal is called when there is no sentence yet. */
    modes: {
      /* AND EDIT IS ONE INPUT - Babe, 2026-10-30: "then style / edit
       * should change the slots. for example slot becomes a two input.
       * edit is single." STYLE is the two-image combine this rung was
       * always for; an edit changes one named thing in one photograph,
       * and with a box table that can point at it the second reference
       * is a picture with no question to answer. The drop is what the
       * panel reads: `takes` loses `ref`, the cell goes, and the left
       * draws one square - the same thing SWAP and EDIT do on 06. */
      EDIT: {
        drop: ["475"],
        label: "Edit the picture",
        /* AND AN EDIT NEEDS SOMETHING TO EDIT. The row dropped `source`
         * from `required` so that STYLE can run on words alone; this mode
         * puts it back, which is also what takes every row off the picker
         * here while the panel is empty. */
        required: ["source", "prompt"],
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
        sys: (v) => (v.blank.source ? T2I_SYS(v) : STYLE_SYS(v)),
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
        /* AND THIS IS THE OPEN ROW THAT DOES IT, which was read off the
         * graph rather than hoped at: `qwen-21-turbo-t2i.json` - the one
         * 01's RANDOM has rolled on since the roll was built - is a
         * `TextEncodeQwenImage21` with NO images at all and an
         * `EmptyLatentImage` beside it. Drop both loaders here and that is
         * structurally what is left, so the proven t2i shape costs no graph.
         * THE TURBO ROW CANNOT, and for the reason it has no AR cell: its
         * KSampler takes its latent FROM the encoder, which derives it from
         * the source. No source, no latent. */
        required: ["prompt"],
        dropWhenEmpty: { ref: ["475"], source: ["470"] },
        fillWhenEmpty: { source: "ref" },
        defaults: { steps: 25, width: 1024, height: 1024 },
        params: ["ar", "seed", "steps"],
        /* the same two modes here. `sys` is a string on this row and goes in
         * front of what the artist wrote, which is the one difference between
         * the rows and the reason the scaffolding lives beside the graph. */
        modes: {
          EDIT: {
            drop: ["475"],
            label: "Edit the picture",
            /* an edit needs something to edit - see the base row */
            required: ["source", "prompt"],
            sys: (v) => EDIT_LINE(!!v.ref),
          },
        },
      },
      "QWEN-IMAGE-21-TURBO": {
        graph: "qwen-image-21-turbo.json",
        label: "Become someone",
        sys: (v) => STYLE_SYS(v),
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
            drop: ["475"],
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
        /* AND THE BOXES ARE THIS ROW'S FORMAT, NOT THE RUNG'S - Babe,
         * 2026-10-29: "do you think boxes should only show up if you select
         * flux 3 for edit". They should: the table at the end of the prompt
         * is BFL's annotator format, one JSON array of rows with coordinates
         * 0..1000, and it is the thing `i2i_bbox` was trained to read.
         * EVERY OTHER ROW GETS A BLOCK OF INTEGERS. Nano reads it as part of
         * an instruction, the qwen rows take it at cfg 1 where conditioning
         * is the only steering they have, MOSS's edit LoRA has never seen one
         * and Krea rewrites the prompt before generating - so the face would
         * be a control that does nothing, drawn on a picture, which is worse
         * than no control and worse than a lie about what was sent. */
        boxes: true,
        /* addressed by the encoder's own token names, the way qwen's is
         * addressed as image_1 and image_2 - `modes.EDIT` below overrides
         * this with the edit line and passes the same two names. */
        sys: (v) => STYLE_SYS(v, "<ref_image_0>", "<ref_image_1>"),
        inputs: {
          source: { node: "11", input: "image" },
          ref: { node: "12", input: "image" },
          prompt: { node: "100", input: "value" },
          steps: { node: "7", input: "steps", cast: Number },
          seed: { node: "7", input: "seed", cast: Number },
        },
        /* AND THE SOURCE CANNOT BE REQUIRED HERE ANY MORE, because the
         * swap below covers the one state that would have refused: with a
         * source the base runs and the requirement is already met, and
         * without one the swap replaces the spec and states its own. A
         * requirement that can never fire is one the picker reads as a
         * reason to hide the row - which is the whole of what `required`
         * is for now. EDIT restates it, because an edit of nothing is not
         * a job. Same shape as Kling on 05. */
        required: ["prompt"],
        /* the second loader goes when nobody filled it, and the reference
         * slot on the conditioning node goes with it - so the sentence stops
         * naming <ref_image_1> in the same breath, because `sys` reads the
         * values the drops were taken out of. */
        dropWhenEmpty: { ref: ["12"] },
        defaults: { steps: 16 },
        params: ["seed", "steps"],
        /* AND WITH NOTHING IN THE PANEL IT IS TEXT TO IMAGE, 2026-10-31.
         * Babe, with the vendor's own t2i template open: "flux 3 image
         * klein t2i".
         * THE GRAPH FOR IT IS ALREADY IN THIS REPO AND 03 AND 04 RUN IT.
         * Klein was written off for t2i this morning on a true reading of
         * `ReferenceMultiLatent` - `images.image0` must be filled - and the
         * rest of that node's own hint is the answer: THE LIST MAY BE
         * OMITTED ENTIRELY. Drop both loaders and the references go with
         * them, the conditioning passes straight through, and the sampler
         * takes its latent from the `EmptyFlux2LatentImage` that
         * `flux3-klein-2ref-latent.json` already carries for 03 and 04.
         * Simulated node by node: 11 left, nothing dangling.
         * SO IT IS A SWAP RATHER THAN A DROP, for the reason Kling's t2v
         * was: the row's own graph has no latent of its own to size, so a
         * dropped loader cannot become one - and an AR cell cannot appear
         * because a loader left. A swap states what differs and inherits
         * the rest.
         * AND IT CHANGES NO PROVEN PATH, because `required` refused this
         * state outright: a Klein run with no source could not be made.
         * A REFERENCE WITH NO SOURCE IS STILL THE PROMOTION every other
         * t2i row here makes - `fillWhenEmpty` moves it into image 1's own
         * address so the model counts it first, and `T2I_SYS` then says in
         * so many words that the one picture is not the subject. */
        swapWhenEmpty: {
          source: {
            graph: "flux3-klein-2ref-latent.json",
            sys: (v) => T2I_SYS(v, "<ref_image_0>"),
            inputs: {
              source: { node: "11", input: "image" },
              ref: { node: "12", input: "image" },
              prompt: { node: "100", input: "value" },
              /* THE LATENT IS OURS NOW, so the row gains the cell it has
               * never had on this rung - and 16 is the rounding this
               * family wants, which is what the two other Klein rows that
               * sample their own latent already do. */
              width: { node: "20", input: "width", cast: (v) => Math.round(v / 16) * 16 },
              height: { node: "20", input: "height", cast: (v) => Math.round(v / 16) * 16 },
              steps: { node: "7", input: "steps", cast: Number },
              seed: { node: "7", input: "seed", cast: Number },
            },
            required: ["prompt"],
            fillWhenEmpty: { source: "ref" },
            dropWhenEmpty: { source: ["11"], ref: ["12"] },
            defaults: { steps: 16, ar: "1:1" },
            params: ["ar", "seed", "steps"],
          },
        },
        modes: {
          EDIT: {
            drop: ["12"],
            label: "Edit the picture",
            sys: (v) => EDIT_LINE(!!v.ref, "<ref_image_0>", "<ref_image_1>"),
            required: ["source", "prompt"],
            /* AND AN EDIT OF NOTHING IS NOT A JOB. The swap runs after the
             * modes merge, so a tab that must have a picture has to say so
             * - the same `{}` Kling's two first-frame tabs use. */
            swapWhenEmpty: {},
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
      /* MOSS-IMAGE, AND ITS SCAFFOLDING IS THE LORA'S OWN TRAINING PHRASE -
       * Babe, 2026-10-29: "can we add qwen to the first one and this new one
       * called MOSS", with the Image Edit LoRA card.
       * THE TEMPLATE SAYS WHAT WORKS AND IT IS NOT A GUESS: "the phrasing the
       * LoRA was trained on works best: 'Change only the X to Y. Keep the
       * character, face, hair, pose, background and composition unchanged.'"
       * So this row's line is that sentence with the artist's half left to
       * fill, which is EDIT_LINE's construction one model over - operation
       * first, a colon at the end, the instruction last.
       * AND IT RUNS AT CFG 4, unlike every other open row on this rung. The
       * two qwen rows and Klein sample at cfg 1, where conditioning is the
       * only steering there is and length costs; here there is a negative
       * branch and the template warns that lowering the cfg is what makes
       * jewellery appear out of nowhere. The negative stays the model's own
       * recommended line, in the graph, where it belongs. */
      /* KREA 3, WHICH IS THE ONLY ROW ON THIS RUNG BESIDES NANO THAT DOES
       * BOTH TABS AND MEANS IT - Babe, 2026-10-29, having first pointed at
       * Krea-2's Image Style Reference: "maybe this instead actually".
       * IT IS NOT, AND THE REASON IS THE FACE. Krea-2 Style Reference takes
       * `image1`, `image2` and `image3` and every one of them is a STYLE
       * reference - the subject comes from the text. There is no identity
       * input at all, so on the rung whose whole job is that the face in the
       * photograph survives, it would hand back a beautiful stranger: this
       * rail's oldest failure, a second picture with no stated role being
       * averaged into the answer.
       * KREA 3 TAKES REAL IMAGES - up to eight, "numbered in connection
       * order", addressed in the prompt as `@Image1`, `@Image2`, which is
       * Seedance's convention and therefore one this server already speaks:
       * STYLE_SYS and EDIT_SYS have taken token names since the open rows
       * were shortened, so neither needed a word written for this.
       * AND `precise_edit` IS THIS RUNG'S TWO TABS IN A BOOLEAN - "keep
       * everything outside the edited area unchanged". False where the job
       * is a restyle so large only the face survives, true where it is one
       * named change. A mode's `defaults` replaces the whole table, so the
       * two cells they share are a const rather than written out twice. */
      "KREA-3": {
        graph: "krea3-image-edit.json",
        label: "Become someone",
        /* AND KREA 3 DOES BOTH TEMPLATES ON ONE GRAPH - Babe, 2026-10-31,
         * with both cards on screen: "would like to add krea 3 btw... text
         * to image and text image edit".
         * IT IS ALREADY WIRED FOR THE SECOND AND THE FIRST IS FREE.
         * `api_krea3_t2i` and `api_krea3_image_edit` are the SAME NODE with
         * the same inputs, which was read off the template's own schema
         * rather than assumed - the only difference between the two is that
         * the t2i one has no LoadImages in it. Which is what
         * `dropWhenEmpty` does. No second graph, no second row, and the
         * prune takes the dangling sockets out with the loaders. */
        sys: (v) => (v.blank.source
          ? T2I_SYS(v, "@Image1")
          : STYLE_SYS(v, "@Image1", "@Image2")),
        inputs: {
          /* AND A FILE GOES TO A LOADER, NEVER TO THE NODE THAT READS IT -
           * Babe, 2026-10-29, the press after the slot names were corrected:
           * "node 1 (Krea3ImageNode) input model.images.image_0 expects a
           * linked image but received a literal value". The slot names were
           * right by then; the ADDRESS was not. Every other graph on this
           * rail patches the LoadImage's filename and lets the link carry it,
           * and this one was addressing the model node directly because its
           * images arrive as conditional sub-fields in the schema and read
           * like inputs. They are sockets. */
          source: { node: "8", input: "image" },
          ref: { node: "10", input: "image" },
          prompt: { node: "1", input: "model.prompt" },
          ar: { node: "1", input: "model.aspect_ratio",
                cast: (v) => String(v).toUpperCase() === "AUTO" ? "auto" : v },
          res: { node: "1", input: "model.resolution" },
          precise: { node: "1", input: "model.precise_edit",
                     cast: (v) => v === true || v === "true" },
          seed: { node: "1", input: "model.seed", cast: Number },
        },
        required: ["prompt"],
        /* AND THE PRESET REACHES THIS ROW AS AN OUTLINE - see `sendLocal`.
         * Krea holds structure hard, which is what makes its EDIT tab faithful
         * and what made a bear come back as a bear BUST: shoulders cut like a
         * carving, on its own plinth. The mannequin stays as what a person sees
         * in the slot. */
        guideFile: "bg/preset-outline.png",
        /* the second loader goes when nobody filled it, and the node's own
         * slot goes with it - the prune reads the graph, so the sentence and
         * the wiring cannot disagree about how many pictures there are.
         * AND THE SLOT NAMES ARE THE TEMPLATE'S, NOT `get_node`'S - Babe,
         * 2026-10-29, on the first press: FAILED TO VALIDATE IMAGES. The
         * catalogue reports this node's auto-grow slot as
         * `model.images.item_1`; the workflow it ships names them
         * `model.images.image_0` and `model.images.image_1`, 0-based, like
         * every other auto-grow list on this rail. BOTH addresses were wrong,
         * so the node received no image it recognised and refused the job at
         * submit - a PAID refusal rather than a free one, which is what makes
         * this worth the comment: `get_node` is free and authoritative about
         * options and tooltips, and it was wrong about the one thing a dry
         * run cannot check. The template's own workflow JSON is the
         * authority, and it is free too. */
        dropWhenEmpty: { ref: ["10"], source: ["8"] },
        fillWhenEmpty: { source: "ref" },
        defaults: { ...KREA_DEF, precise: false },
        /* ITS OWN VOCABULARY: an `auto` that reads the shape off the pictures,
         * 1K or 2K and no 4K, and a 4:5 and 5:4 this cell does not offer. */
        options: { ar: ["AUTO", "1:1", "2:3", "3:4", "3:2", "4:3", "9:16", "16:9", "21:9"],
                   res: ["1K", "2K"] },
        /* NO STEPS: there is no sampler here to count. `thinking_mode` is the
         * knob that would go in its place - fast, high, ultra - and it stays
         * on the `fast` the node recommends until somebody has a reason. */
        params: ["ar", "res", "seed"],
        modes: {
          EDIT: {
            drop: ["10"],
            label: "Edit the picture",
            /* an edit needs something to edit - see the base row */
            required: ["source", "prompt"],
            sys: (v) => EDIT_SYS(!!v.ref, "@Image1", "@Image2"),
            defaults: { ...KREA_DEF, precise: true },
          },
        },
      },
      "MOSS-IMAGE": {
        graph: "moss-image-edit.json",
        label: "Become someone",
        /* AN EDIT LORA EDITS. It redraws the same frame with one change
         * applied, which is this tab and not the other one - STYLE is a
         * restyle so large that only the face survives, and asking this for
         * that is asking it to do the thing its training says not to. */
        only: "EDIT",
        inputs: {
          source: { node: "8", input: "image" },
          ref: { node: "40", input: "image" },
          prompt: { node: "39", input: "prompt" },
          steps: { node: "37", input: "steps", cast: Number },
          seed: { node: "37", input: "seed", cast: Number },
        },
        required: ["source", "prompt"],
        /* THE SECOND REFERENCE IS WIRED BECAUSE THE ENCODER TAKES ONE. Its
         * own note: "the encode nodes autogrow images.image_0, image_1...
         * connect up to four photos (a garment, a face, a prop) and say in
         * the prompt what each one is for" - which is exactly what 01's EDIT
         * tab means by its right slot. Leaving it unwired would have made
         * that box a picture that never reached the model.
         * ITS SCALER GOES WITH IT, because a reference enters at the size it
         * arrives with and an unscaled one is expensive for nothing. */
        dropWhenEmpty: { ref: ["40", "41"] },
        defaults: { steps: 30 },
        options: { steps: ["20", "30", "40"] },
        /* NO AR CELL: GetImageSize feeds the latent, so the output keeps the
         * source's own shape - the same arrangement Klein and the qwen turbo
         * have, and for the same reason. */
        params: ["steps", "seed"],
        modes: {
          EDIT: {
            /* AND THE SCALER GOES WITH THE LOADER. Every other row on this
             * rung drops ONE node for its second reference; MOSS has two -
             * the loader and its own ImageScaleToTotalPixels - which is why
             * dropWhenEmpty names both. Dropping 40 alone left 41 pointing
             * at a node that is not there and the encoder still naming it. */
            drop: ["40", "41"],
            label: "Edit the picture",
            sys: (v) => MOSS_EDIT_LINE(!!v.ref),
          },
        },
        /* (*) IT IS THE int8_convrot UNET, which is the one this rail has
         * been bitten by: three qwen turbo rolls came back as flat dotted
         * grey texture and the fix was one line, the catalogue's bf16 build.
         * If the first MOSS roll is texture rather than a picture, swap node
         * 30 to moss_image_sft_bf16.safetensors before suspecting anything
         * else. */
      },
      /* THE TWO ROWS THAT ONLY DO THIS - Babe, 2026-10-31: "can we add moss
       * text to image", then "we should prob add z-turbo t2i, which still
       * seems to be popular".
       * EVERY OTHER T2I ROW ON THIS RUNG IS AN EDIT MODEL RUN EMPTY. Nano,
       * qwen-edit, Krea and Klein all take a picture and happen to run
       * without one; these two have no image input at all, which is why
       * they need the picker's other half - a row that cannot be handed
       * what you are holding is not offered, the same sentence `takes`
       * already says one level in about a FACE.
       * BOTH ARE OPEN WEIGHTS AND BOTH GRAPHS COST ONE run_template EACH,
       * which is the trade this file named for a subgraph template and
       * took for LTX 2.3 the same morning. Flattening one free is the
       * converter that ended 21 widget-slots short, and a wrong widget on
       * a checkpoint fails after you have paid. */
      "Z-IMAGE-TURBO": {
        graph: "z-image-turbo-t2i.json",
        /* AND IT IS PINNED TO THE IMAGE TAB, 2026-11-01 - Babe, with the
         * picker on EDIT holding this and MOSS-IMAGE-T2I and nothing else:
         * "i think we lose flux edit?".
         * THE FILTER WAS WORKING AND THE SURVIVORS WERE WRONG. Every row
         * that can edit requires `source`, so with an empty panel they are
         * all hidden - and the two rows left standing were the two that
         * require nothing but a sentence, which is exactly the property
         * that makes them unable to edit anything. The rule that says IF
         * THE FILTER WOULD HIDE EVERY ROW IT HIDES NONE was written for
         * this state and could not fire, because these two were not
         * hidden.
         * A ROW THAT CANNOT DO THE JOB OF THE TAB IS NOT ON THE TAB, which
         * is what `only` has meant since SCAIL-2. This graph has no image
         * input at all, so on EDIT it could only ignore the picture and
         * generate - which is the other tab's job wearing this one's name. */
        only: ["STYLE"],
        label: "Become someone",
        /* 6B, 8 steps, cfg 1 with the negative zeroed out - the fastest
         * thing on the rail and the one this rung's RANDOM now rolls on. */
        sys: (v) => T2I_SYS(v),
        inputs: {
          prompt: { node: "57:27", input: "text" },
          ar: { node: "19", input: "aspect_ratio", cast: (v) => AR_LABEL[v] || v },
          steps: { node: "57:3", input: "steps", cast: Number },
          seed: { node: "57:3", input: "seed", cast: Number },
        },
        required: ["prompt"],
        defaults: { steps: 8, ar: "1:1" },
        /* distilled to 8; the list goes up rather than down because below
         * it the model has nothing left to take away. */
        options: { steps: ["8", "12", "16"] },
        params: ["ar", "seed", "steps"],
      },
      /* (*) AND THE NAME IS MINE. It is the same checkpoint the EDIT row
       * above runs - `moss_image_sft` - without the edit LoRA, so the two
       * are one model doing two jobs and the suffix is the only thing
       * telling them apart. `MINIMAX-H3-OPEN` is the precedent for a
       * suffix naming the variant; Babe's to rename. */
      "MOSS-IMAGE-T2I": {
        graph: "moss-image-t2i.json",
        /* AND THE SAME PIN, for the same reason - see Z-IMAGE-TURBO. */
        only: ["STYLE"],
        label: "Become someone",
        sys: (v) => T2I_SYS(v),
        inputs: {
          prompt: { node: "18:4", input: "text" },
          ar: { node: "19", input: "aspect_ratio", cast: (v) => AR_LABEL[v] || v },
          steps: { node: "18:7", input: "steps", cast: Number },
          seed: { node: "18:7", input: "seed", cast: Number },
        },
        required: ["prompt"],
        defaults: { steps: 25, ar: "1:1" },
        options: { steps: ["16", "25", "32", "40"] },
        params: ["ar", "seed", "steps"],
      },
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
            drop: ["12"],
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
    sys: MOTION_SYS,
    inputs: {
      clip: { node: "1", input: "file" },
      ref1: { node: "2", input: "image" },
      ref2: { node: "3", input: "image" },
      /* A FOURTH REFERENCE, AND THE ONLY ONE THE RAIL DOES NOT NAME - Babe,
       * 2026-10-30: "should the 4th one be something that can be referenced
       * in a prompt. like a MISC (another character, prop, etc)", then "it
       * can just be MISC".
       * THE NODE HAS ROOM FOR THIRTY and the graph wired two, which is why
       * the quad showed three cells: the wiring, not the model.
       * AND AN UNNAMED REFERENCE IS SAFE THE WAY 01's SECOND ONE IS - by
       * naming the ROLE rather than the object. That slot has been "the
       * thing the instruction refers to, a jacket or a hat" since EDIT was
       * built, with its face, framing, light and background refused by
       * name.
       * AND IT IS SOUND RATHER THAN A PICTURE, 2026-10-30. MISC went in as
       * a fourth IMAGE and the one run it got came back with the red liquid
       * and not the flask - the model weighed it lightly, which is what an
       * unnamed extra picture beside three named ones gets. Babe, with the
       * node open: "should misc be audio actually?", then "we should prob
       * unlock audio as a reference because then we can explore other
       * models / workflows".
       * AND IT IS THE SAME JOB ACROSS THREE ROWS, which a fourth picture
       * never was: `model.reference_audios.audio_1` is real on Seedance and
       * `ref_audios.ref_audio_0` is real on H3 and Pika, so one cell works
       * on a partner row and two open ones. It is also a job no other cell
       * can do - 05's agent has written `AUDIO:` lines since the timeline
       * format landed with nothing to point them at.
       * (*) ON H3 IT NEEDS `audio_vae` WIRED or the reference only reaches
       * the text encoder, which the node says itself. Seedance is an API
       * node and has no such catch. */
      audio: { node: "6", input: "audio" },
      prompt: { node: "4", input: "model.prompt" },
      task: { node: "4", input: "model.task_type" },
      /* AND THE SHAPE, WHICH THIS NODE HAS ALWAYS TAKEN AND NO CELL COULD
       * REACH - Babe, 2026-10-31: "lets go through all the models and make
       * sure that AR is there". `model.ratio` has sat at `adaptive` in the
       * graph since the rung was built, which is the right DEFAULT and is
       * not the same thing as a control: 05's own Seedance row got this
       * cell on 2026-10-27 and this one was simply never looked at.
       * AUTO IS THE WORD AND `adaptive` IS THE WIRE, the way it is one rung
       * over - the cell carries what a person reads and the cast carries
       * what the node answers to.
       * AND IT IS RESHOOT'S ALONE. Every other tab here runs `edit` or
       * `extend`, and the node's own definition of edit is that the output
       * KEEPS THE SOURCE CLIP'S LENGTH AND ASPECT RATIO - so a ratio sent
       * there is a control that does nothing, which is the one thing this
       * row must not draw. The three modes restate `params` without it. */
      ar: { node: "4", input: "model.ratio",
            cast: (v) => String(v).toUpperCase() === "AUTO" ? "adaptive" : v },
      size: { node: "4", input: "model.resolution" },
      duration: { node: "4", input: "model.duration", cast: Number },
      sound: { node: "4", input: "model.generate_audio", cast: (v) => v !== "DROP" && v !== false },
      seed: { node: "4", input: "seed", cast: Number },
    },
    /* AND THE CHARACTER IS AN ANSWER, NOT A REQUIREMENT - see MOTION_SYS.
     * A reshoot with a clip and a direction is a real job and the node says
     * so (`ref_images` is min_slots 0). SWAP restates `required` below,
     * because replacing the performer with nobody is not one. */
    required: ["clip", "prompt"],
    /* the place is a second answer, not a required one: without it the recast
     * still holds and the driving clip's own room is what you get. */
    dropWhenEmpty: { ref1: ["2"], ref2: ["3"], audio: ["6"] },
    defaults: { task: "reference", size: "720p", sound: "KEEP", duration: 6, ar: "AUTO" },
    params: ["ar", "size", "seed", "sound"],
    /* ITS VOCABULARY IS ITS OWN: no 2:3 and no 3:2, and an `adaptive`
     * nothing else on this rung has. Same seven as 05's Seedance, because
     * it is the same node. */
    options: { ar: ["AUTO", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
               size: ["480p", "720p", "1080p"] },
    /* A MODE ENTRY OVERRIDES WHAT IT NAMES AND INHERITS THE REST, which is
     * why RECAST is not in here: it is the base. */
    modes: {
      /* SWAP is `edit` pointed at the performer: the clip stands and the
       * person changes. One reference is the whole of it - the place is the
       * clip's own, which is the difference from RECAST. */
      SWAP: {
        defaults: { task: "edit", size: "720p", sound: "KEEP" },
        drop: ["3", "6"],
        /* an edit keeps the source clip's own aspect, so AR is a cell that
         * could only lie here - see the base's `ar`. */
        params: ["size", "seed", "sound"],
        /* AND SWAP STILL NEEDS ONE: the whole job is who steps into the
         * shot, so a swap with nothing to swap in has to refuse where you
         * can see it rather than at Comfy. */
        required: ["clip", "ref1", "prompt"],
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
        drop: ["2", "3", "6"],
        required: ["clip", "prompt"],
        params: ["size", "seed", "sound"],
      },
      /* EXTEND returns ONLY the newly generated segment, not the source clip
       * with more on the end - so DUR is the length of the new piece, and the
       * references are what it has to match. */
      /* AND IT TAKES THE CLIP AND NOTHING ELSE - Babe, 2026-10-30, looking
       * at the panel: "extend as two inputs... is that right?". It is not,
       * for two reasons that point the same way.
       * THE SENTENCE ALREADY TAKES EVERYTHING FROM THE VIDEO: "holding the
       * same character, wardrobe, room, light, lens and pace". A character
       * reference beside that is a second answer to a question the clip has
       * already answered, which is the averaging trap this rail keeps
       * paying for.
       * AND AN EMPTY ONE WAS A JOB THAT FAILS AT COMFY. `ref1` is not
       * `required` here and node 2 was not dropped, so an EXTEND with
       * nobody in CHARACTER submitted a LoadImage with an empty filename -
       * a refusal nobody could see the cause of.
       * IT IS ALSO EDIT'S SHAPE, which drops both: the same connected-video
       * task, and that node refuses a job with an image beside it at
       * SUBMIT. Dropping is the safe direction either way - unproven, and
       * if extend does want a reference the cost of having dropped it is a
       * cell rather than a paid refusal. */
      EXTEND: {
        defaults: { task: "extend", size: "720p", sound: "KEEP", duration: 5 },
        drop: ["2", "3", "6"],
        required: ["clip", "prompt"],
        params: ["size", "seed", "sound"],
      },
    },
    variants: {
      /* KLING 4.0 ON THE RUNG THAT LOOPS, 2026-10-31. Two of its four
       * templates land here: `Kling4ReferenceToVideoNode` takes reference
       * IMAGES and reference VIDEOS together, which is this rung's quad
       * exactly - a clip for the motion, a character, a place - and
       * `Kling4EditVideoNode` keeps the source pixels and the source length,
       * which is EDIT's whole contract.
       * RESHOOT AND SWAP ARE ONE MACHINE AND TWO SENTENCES, the arrangement
       * this rung has used since it was built: the mode is the job and the
       * node is the machine. SWAP drops the place, because the clip's own
       * room standing is the difference between the two jobs.
       * AND IT CANNOT EXTEND, so `only` says so rather than letting a tab
       * promise a job the graph has no way to do - except that EXTEND came
       * off this rung on 2026-10-31, so the list is the three that are left
       * and is written out anyway: a row that gains a fourth tab later
       * should have to say so. */
      "KLING-4.0": {
        graph: "kling4-r2v.json",
        label: "Your own shot",
        only: ["RESHOOT", "SWAP", "EDIT"],
        sys: KLING_R2V_SYS,
        inputs: {
          clip: { node: "12", input: "file" },
          ref1: { node: "10", input: "image" },
          ref2: { node: "11", input: "image" },
          /* THE FOURTH CELL IS A PROP HERE, NOT A SOUND - Babe, 2026-11-01:
           * "can we turn the 4th slot into something so its not just blank,
           * make it usable", "we can update the slots based on the model",
           * "that is part of our pattern making, the slots are based on the
           * mode or model". This node takes TEN reference images and no
           * audio at all, so the quad's fourth quadrant was drawn dark on
           * the one row with eight picture slots going spare.
           * AND IT IS A NAMED JOB, WHICH IS THE WHOLE RULE: the fourth cell
           * was MISC once - an unnamed extra picture - and it came back with
           * the liquid recoloured and the flask untouched, weighed lightly
           * beside three named references. A PROP is the half of the hands
           * clause this rail has paid for twice: the scaffolding already
           * refuses the objects in the performer's hands and hands that job
           * to the direction, and until now there was no way to supply a
           * PICTURE of the thing.
           * THE KEY IS `audio` BECAUSE A KEY IS AN ADDRESS. It is what the
           * quad's fourth face sends under, the way 06's first mode is still
           * keyed RECAST and 01's IMAGE tab is still keyed STYLE; what the
           * cell IS is the row's to say, which is `names` and `accept` below.
           * The day a third row wants a different fourth job, the honest move
           * is to let the SLOT take its fourth key from the row.
           * (*) UNRUN. */
          audio: { node: "13", input: "image" },
          prompt: { node: "1", input: "model.prompt" },
          ar: { node: "1", input: "model.aspect_ratio",
                cast: (v) => String(v).toUpperCase() === "AUTO" ? "adaptive" : v },
          size: { node: "1", input: "model.resolution" },
          duration: { node: "1", input: "model.duration", cast: Number },
          seed: { node: "1", input: "model.seed", cast: Number },
        },
        required: ["clip", "prompt"],
        /* what this row calls its cells, and what each one takes */
        names: { audio: "Prop" },
        accept: { audio: "image/*" },
        /* a reference nobody filled takes its loader with it, and the
         * sentence stops naming it in the same breath - `drops` is computed
         * before `sys`, which is the whole reason that order exists. */
        dropWhenEmpty: { ref1: ["10"], ref2: ["11"], audio: ["13"] },
        /* AND THE PLACE MOVES UP WHEN THERE IS NO CHARACTER. The graph wires
         * the character to image_1 and the place to image_2, so a reshoot
         * with only a place would leave one picture in the SECOND slot while
         * the model counts in connection order - 01's numbering trap, one
         * rung over. `KLING_R2V_SYS` reads `blank.ref1` to tell a promoted
         * place from somebody to become. */
        fillWhenEmpty: { ref1: "ref2", ref2: "audio" },
        params: ["ar", "size", "duration", "seed"],
        options: { ar: ["AUTO", "16:9", "9:16", "1:1", "21:9"],
                   size: ["720p", "1080p"], duration: KLING_SECS },
        defaults: { ar: "AUTO", size: "720p", duration: 5 },
        modes: {
          /* the clip stands and the person changes, so the place is not a
           * question this mode asks. */
          /* AND A SWAP TAKES NO PROP, because its own sentence promises
           * "the same things in their hands": the clip stands and the person
           * changes, so a picture of an object is a second director. */
          SWAP: { drop: ["11", "13"], required: ["clip", "ref1", "prompt"] },
          /* AND AN EDIT IS A DIFFERENT NODE, which keeps the source length -
           * so there is no duration to set, exactly as on FLUX-VIDEO-EDIT.
           * (*) IT ALSO TAKES A REFERENCE IMAGE, which Seedance's edit
           * refuses at submit, and that is deliberately not wired yet: it
           * would make the quad show a CHARACTER cell on this row and not on
           * the one beside it, which is a behaviour to decide rather than to
           * ship as a side effect. One entry in `inputs` the day it is
           * wanted. */
          EDIT: {
            graph: "kling4-edit.json",
            sys: () => KLING_EDIT_SYS(),
            drop: [],
            dropWhenEmpty: {},
            fillWhenEmpty: {},
            inputs: {
              clip: { node: "12", input: "file" },
              prompt: { node: "1", input: "model.prompt" },
              ar: { node: "1", input: "model.aspect_ratio",
                    cast: (v) => String(v).toUpperCase() === "AUTO" ? "adaptive" : v },
              size: { node: "1", input: "model.resolution" },
              seed: { node: "1", input: "model.seed", cast: Number },
            },
            required: ["clip", "prompt"],
            params: ["ar", "size", "seed"],
            options: { ar: ["AUTO", "16:9", "9:16", "1:1", "21:9"],
                       size: ["720p", "1080p"] },
            defaults: { ar: "AUTO", size: "720p" },
          },
        },
      },
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
    sys: H3_SYS,
    inputs: {
      clip: { node: "1", input: "file" },
      ref1: { node: "2", input: "image" },
      ref2: { node: "3", input: "image" },
      prompt: { node: "4", input: "model.prompt" },
      size: { node: "4", input: "model.resolution" },
      duration: { node: "4", input: "model.duration", cast: Number },
      seed: { node: "4", input: "seed", cast: Number },
    },
    /* AND THE CHARACTER IS AN ANSWER, NOT A REQUIREMENT - see MOTION_SYS.
     * A reshoot with a clip and a direction is a real job and the node says
     * so (`ref_images` is min_slots 0). SWAP restates it, because replacing
     * the performer with nobody is not one. */
    required: ["clip", "prompt"],
    dropWhenEmpty: { ref1: ["2"], ref2: ["3"] },
    modes: {
      SWAP: {
        /* AND SWAP STILL NEEDS ONE: the whole job is who steps into the
         * shot, so a swap with nothing to swap in refuses where you can see
         * it rather than at Comfy. */
        required: ["clip", "ref1", "prompt"],
      },
    },
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
   * IT IS RESHOOT AND SWAP, AND THE REASON IT WAS RESHOOT ALONE WAS WRONG.
   * `reference` is the only TASK this graph performs, and I read that as the
   * only job - but SWAP is not a task type here, it is a sentence, which is
   * the distinction Seedance's own two modes have made since they were built.
   * What it genuinely cannot do is EDIT or EXTEND: both keep the source
   * pixels and this regenerates, and nothing here carries past the last
   * frame. So the pin is a list of the two it can answer rather than a single
   * string that could only say one or none - and the tabs still cannot
   * promise what the graph has no way to do.
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
    /* TWO JOBS, ONE MACHINE, AND THE SENTENCE IS THE DIFFERENCE. See
     * H3_SWAP_SYS: there is no task type on these weights, so a reshoot and a
     * swap are the same forward pass told two different things. RESHOOT
     * regenerates the shot around the movement; SWAP leaves the footage
     * standing and changes who is in it. */
    sys: (v) => (v.mode === "SWAP" ? H3_SWAP_SYS(!!v.audio)
                                     : H3_R2V_MOVE_SYS(v)),
    only: ["RESHOOT", "SWAP"],
    /* AND SWAP DROPS THE PLACE, which is what makes it a swap: the room is
     * the clip's own. The same drop the base spec's SWAP has made since the
     * mode was built, at this graph's own address. */
    modes: {
      SWAP: {
        drop: ["139"],
        /* AND SWAP STILL NEEDS ONE: the whole job is who steps into the
         * shot, so a swap with nothing to swap in refuses where you can see
         * it rather than at Comfy. */
        required: ["clip", "ref1", "prompt"],
      },
    },
    inputs: {
      clip: { node: "150", input: "file" },
      ref1: { node: "137", input: "image" },
      ref2: { node: "139", input: "image" },
      /* AND THE SOUND, FOR THE REASON THE SENTENCE FORCED. This row shares
       * `H3_R2V_MOVE_SYS` with Pika, and the moment that sentence learned to
       * name <Audio 1> it would have named one here too - `seen` carries
       * every value, and a key with no address is not dropped, so the clause
       * would have fired for a graph with nowhere to put the file. A
       * SENTENCE NAMING A FILE THAT WAS NEVER SENT is this rail's oldest
       * failure, so the choice was to wire it or to teach the clause about
       * addresses. Wiring it is the smaller change and it makes the two
       * sibling rows identical again. Same node, same slot, same loader. */
      audio: { node: "152", input: "audio" },
      prompt: { node: "138", input: "value" },
      duration: { node: "132", input: "value", cast: Number },
      seed: { node: "129", input: "noise_seed", cast: Number },
    },
    /* AND THE CHARACTER IS AN ANSWER, NOT A REQUIREMENT - see MOTION_SYS.
     * A reshoot with a clip and a direction is a real job; SWAP restates it
     * above, because replacing the performer with nobody is not one. */
    required: ["clip", "prompt"],
    dropWhenEmpty: { ref1: ["137"], ref2: ["139"], audio: ["152"] },
    defaults: { duration: 6 },
    params: ["seed"],
  },
  /* PIKA H3 FLEX ON THE RUNG THAT LOOPS - the same Pika adapter 05 carries,
   * on the same Ref2VA weights, with a clip wired in. Wired and deliberately
   * NOT on the row, for GENJUTSU's reason and MINIMAX-H3-OPEN's: three rows
   * per rung, and the third seat is SCAIL-2's.
   * AND IT IS THE ANSWER TO THE ONE THING PARKED AGAINST THAT SEAT. 06's
   * open RESHOOT ran at 249.1s and this file has said since that it is "a
   * long wait in front of a demo" - which is the whole reason the open row
   * on the rung every shot after the return is made on stayed off the rail.
   * Six steps against twenty is that number's only real lever, and it did
   * not exist until Pika shipped this.
   * AND IT TAKES 05 'S OWN NAME, not a `-OPEN` suffix: that suffix means the
   * same job on the same rung for money. Add its name to 06's `models` in
   * the slide table and it appears; nothing else changes.
   * (*) UNRUN - the graph is this rung's own clip graph with three values
   * moved, and dry-run clean, but no clip has come back from it. */
  "PIKA-H3-FLEX": {
    graph: "pika-h3-flex-r2v-clip.json",
    model: "PIKA-H3-FLEX",
    label: "Your own shot",
    /* TWO JOBS, ONE MACHINE, AND THE SENTENCE IS THE DIFFERENCE. See
     * H3_SWAP_SYS: there is no task type on these weights, so a reshoot and a
     * swap are the same forward pass told two different things. RESHOOT
     * regenerates the shot around the movement; SWAP leaves the footage
     * standing and changes who is in it. */
    sys: (v) => (v.mode === "EDIT" ? H3_EDIT_SYS()
               : v.mode === "SWAP" ? H3_SWAP_SYS(!!v.audio)
                                   : H3_R2V_MOVE_SYS(v)),
    only: ["RESHOOT", "SWAP", "EDIT"],
    /* AND SWAP DROPS THE PLACE, which is what makes it a swap: the room is
     * the clip's own. The same drop the base spec's SWAP has made since the
     * mode was built, at this graph's own address. */
    modes: {
      /* AND EDIT DROPS BOTH PICTURES - see H3_EDIT_SYS. What is being changed
       * is in the clip, so a reference beside it is a second answer to a
       * question the footage has already answered, and `takes` takes the
       * cells away for us.
       * (*) MINIMAX-H3-OPEN IS THE SAME WEIGHTS AND COULD HAVE THIS TOO. It
       * is off the picker, so it would be a mode nobody can reach - one
       * entry the day that row comes back. */
      /* AND THE SOUND GOES WITH THEM, because this sentence does not name an
       * <Audio 1> - it ends by asking the clip for its own sound. A
       * reference nothing names is one the model averages in, which is the
       * oldest trap on this rail, and Seedance's EDIT drops its audio for
       * the same reason. One `AUDIO_CLAUSE` the day a sound edit is wanted. */
      EDIT: { drop: ["137", "139", "152"], required: ["clip", "prompt"] },
      SWAP: {
        drop: ["139"],
        /* AND SWAP STILL NEEDS ONE: the whole job is who steps into the
         * shot, so a swap with nothing to swap in refuses where you can see
         * it rather than at Comfy. */
        required: ["clip", "ref1", "prompt"],
      },
    },
    inputs: {
      clip: { node: "150", input: "file" },
      ref1: { node: "137", input: "image" },
      ref2: { node: "139", input: "image" },
      /* THE FOURTH CELL REACHES A ROW AT LAST - Babe, 2026-10-31: "for pika
       * h3 can we make the 4th reference work?". It has drawn since the quad
       * was built and only Seedance could be handed it, so on this row it
       * was a cell offering a file that was not going to be sent - which is
       * the failure `takes` exists to stop, sitting in the panel `takes`
       * draws.
       * THE GRAPH WAS THE GAP AND NOT THE MODEL. `audio_vae` has been wired
       * on node 136 since this graph was built, which is the half the node
       * warns about - "without it reference audio only conditions the text
       * encoder". What was missing was a loader and an address.
       * `ref_audios.ref_audio_0` is the slot, typed AUDIO, read off the node
       * rather than guessed - and it goes into the graph as ITS OWN
       * TOP-LEVEL KEY, never as an array under `ref_audios`, which is what
       * an auto-grow list means and what `ref_images.ref_image_0` beside it
       * already does.
       * AND THE SENTENCE MOVED WITH IT, because a reference with no stated
       * job is one the model is free to average into the others. See
       * AUDIO_CLAUSE.
       * (*) MINIMAX-H3-OPEN IS THE SAME NODE AND THE SAME GAP, and is
       * deliberately left alone: it is off the slide table, so no cell can
       * reach it and an input nothing can send is dead code wearing a
       * comment. One entry the day that row comes back. */
      audio: { node: "152", input: "audio" },
      prompt: { node: "138", input: "value" },
      duration: { node: "132", input: "value", cast: Number },
      /* AND THE SHAPE, WHICH THIS GRAPH COULD ALWAYS TAKE - Babe, on an EDIT
       * that came back 1344x768 from a 1280x704 source: "we should prob add
       * the AR cell". Node 115 is the same `ResolutionSelector` 05's Pika
       * row has exposed since it was wired, pinned here to 16:9 at 0.98MP
       * with nothing able to reach it. Same two casts, because it is the
       * same node speaking the same labelled vocabulary. */
      ar: { node: "115", input: "aspect_ratio", cast: (v) => AR_LABEL[v] || v },
      size: { node: "115", input: "megapixels", cast: (v) => AR_MP[v] || Number(v) || 0.98 },
      seed: { node: "129", input: "noise_seed", cast: Number },
    },
    /* AND THE CHARACTER IS AN ANSWER, NOT A REQUIREMENT - see MOTION_SYS.
     * A reshoot with a clip and a direction is a real job; SWAP restates it
     * above, because replacing the performer with nobody is not one. */
    required: ["clip", "prompt"],
    /* AND A LOADER WITH NO FILE IN IT IS A JOB THAT FAILS AT COMFY, so the
     * sound drops when nobody brought one - and `drops` is computed BEFORE
     * `sys`, so the clause naming <Audio 1> goes with the node it names
     * rather than describing one that has been deleted. */
    dropWhenEmpty: { ref1: ["137"], ref2: ["139"], audio: ["152"] },
    defaults: { duration: 6 },
    params: ["ar", "size", "seed"],
  },
  /* LTX 2.3 CONTROL, the open RESHOOT row that holds its source - see
   * LTX23_CONTROL_SYS for why it is RESHOOT and not EDIT. Recovered from
   * `video_ltx2_3_ic_lora` by running the template once and reading the
   * executed API graph back: 45 nodes, 9 top-level plus two subgraphs of 29
   * and 12, with interior ids prefixed `<topId>:`. THAT IS THE CHEAP PATH
   * AND IT IS THE ONE THIS FILE ALREADY NAMED - flattening a subgraph
   * template by hand ended 21 widget-slots short last time, and a wrong
   * widget on a 22B checkpoint fails after you have paid. One run bought an
   * exact graph. */
  "LTX-2.3 CONTROL": {
    graph: "ltx23-control.json",
    model: "LTX-2.3 CONTROL",
    label: "Your own shot",
    sys: LTX23_CONTROL_SYS,
    /* motion transfer is RESHOOT's category, which is Babe's own test for
     * where a row goes - and `only` is what stops the other three tabs
     * promising a job these weights have no way to do. */
    only: ["RESHOOT"],
    inputs: {
      clip: { node: "199", input: "file" },
      /* THE FIRST FRAME, NOT A CHARACTER. It is literally frame one of the
       * clip and it carries the whole look, which is why this row's own
       * `names` calls the cell FIRST FRAME: the model determines the slots.
       * It reaches two nodes - the latent it is painted into and the prompt
       * upsampler we bypass - and only the loader needs the filename.
       * AND IT HAS TO BE THAT CLIP'S OWN FIRST FRAME - Babe, 2026-11-01,
       * after proving the row: "in order for ltx control to work right you
       * need a first frame that matches the clip first frame". NOT a frame
       * from the middle and not a picture of the same character somewhere
       * else: this still is painted into the latent AT frame 0 while MoGe
       * reads the depth of frame 0 beside it, so the two are answering ONE
       * question - what is in front of the camera at t=0 - and a still that
       * disagrees is this rail's oldest trap arriving inside one row.
       * SO THE ONLY CORRECT WAY IN IS THE LIBRARY HOP: FRAME this clip,
       * restyle that frame on 01, bring it back here. A picture dropped
       * straight into the cell is legal, cheap and nearly always wrong, and
       * NOTHING ON THE PAGE SAYS SO - the cell is a `+` like any other.
       * (*) The fix with a mechanism behind it is `fillWhenEmpty` from the
       * clip's own frame 0 (`bigFrame` already pulls one at 1280), which
       * makes the match structural and leaves the RESTYLE as the thing that
       * adds the look rather than the thing that makes the run valid. */
      ref1: { node: "200", input: "image" },
      /* AND THE PROMPT IS THE SWITCH'S `on_false`. See the scaffolding: the
       * upsampler at 129:209 is the branch that does NOT run, so writing
       * there succeeds and returns the demo's jungle ruin. */
      prompt: { node: "129:211", input: "on_false" },
      /* THE TRIM IS THE LENGTH, because the latent's frame count is read off
       * the depth frames. Seconds of control video in, seconds of clip out. */
      duration: { node: "692", input: "duration", cast: Number },
      steps: { node: "129:704", input: "steps", cast: Number },
      seed: { node: "129:704", input: "seed", cast: Number },
    },
    /* AND THE FIRST FRAME IS REQUIRED HERE, which is this row disagreeing
     * with the rung and being right to: a reshoot elsewhere can run on a
     * clip and a direction, and here the image IS the look - without it
     * there is nothing for the depth to be dressed in, and 129:198 would be
     * a `LoadImage` with no file, which is a job that fails at Comfy. */
    required: ["clip", "ref1", "prompt"],
    /* a row says what its cells are called, and this one's first reference
     * is a frame rather than a person. */
    names: { ref1: "First frame" },
    defaults: { duration: 5, steps: 8 },
    params: ["duration", "steps", "seed"],
    options: { duration: ["3", "5", "8", "10"], steps: ["6", "8", "12", "20"] },
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
  /* FLUX VIDEO EDIT, WHICH IS ONE TAB'S JOB AND NOTHING ELSE - Babe,
   * 2026-10-29: "could also be in the video edit mode". The node edits a clip
   * from a written instruction and takes its length, framing, camera motion
   * and audio from the source, which is EDIT's definition on this rung and
   * none of the other three.
   * SO `only` PINS IT, the way it has pinned SCAIL-2 to SWAP since that row
   * was wired - and the picker is what stops a tab promising a job this graph
   * cannot do. EDIT showed two rows; it shows three now, which is the rule
   * rather than an exception to it.
   * AND NO REFERENCE GOES WITH IT. EDIT drops both image loaders on the
   * Seedance row because an image beside an edit is a job that model refuses
   * at submit; here there is nowhere for one to go at all - the node takes a
   * clip and a sentence. */
  "FLUX-VIDEO-EDIT": {
    graph: "flux-video-edit.json",
    model: "FLUX-VIDEO-EDIT",
    label: "Your own shot",
    sys: () => FLUX_EDIT_SYS(),
    only: "EDIT",
    inputs: {
      clip: { node: "2", input: "file" },
      prompt: { node: "7", input: "prompt" },
      seed: { node: "7", input: "seed", cast: Number },
    },
    required: ["clip", "prompt"],
    /* THE SOURCE DECIDES EVERYTHING ELSE. Length, framing and audio come from
     * the clip, and the output is 24fps capped at about 0.9 megapixels a
     * frame - so SIZE and DUR would both be controls that do nothing, which
     * this panel has a rule against. DUR goes on reading the clip's own
     * length, because that is what it is for on this rung. */
    params: ["seed"],
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
    params: ["ar", "seed"],
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
        params: ["ar", "seed", "steps"],
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
      /* AND ON THIS RUNG IT SAMPLES A LATENT OF ITS OWN - Babe, 2026-10-29:
       * "yeah i think we should wire it so we can generate a new latent at
       * 21:9 with flux using the reference frame".
       * EVERYWHERE ELSE THE REFERENCE DECIDING THE SHAPE IS THE FEATURE: on
       * 01 a character comes back the shape of the photograph, on 02 the
       * sheet comes back the shape of its page. Here it meant a board could
       * only ever be the shape of the frame 03 handed over, so AR was a cell
       * this row had to hide while the two beside it offered one.
       * `EmptyFlux2LatentImage` IS THE ONE THAT MATCHES, chosen off the
       * catalogue rather than guessed: this graph's VAE is `flux2-vae` and
       * that node is `model/latent/flux`. The references still arrive through
       * the conditioning - `ReferenceMultiLatent` keeps both its CONDITIONING
       * outputs and only its latent is left unused - so the frame and the
       * page guide a picture whose size is the row's own.
       * AND THE SIZE SNAPS TO 16, because `arSize` rounds to 8 and this
       * family wants both sides a multiple of sixteen. The same rounding
       * Mage-Flow needed, asked for in the one place that knows.
       * IT IS A SECOND GRAPH AND NOT A FLAG, which is the test this file
       * already states: a per-model graph is warranted when the graph
       * DIFFERS, and this one has a node the other does not and a sampler
       * wired somewhere else. */
      "FLUX-3-KLEIN": {
        graph: "flux3-klein-2ref-latent.json",
        label: "The board",
        sys: (v) =>
          BOARD_LINE(v.light, v.mode === "single", !!v.template,
                     "<ref_image_0>", "<ref_image_1>"),
        modes: { custom: { sys: () => FREE_LINE("<ref_image_0>") } },
        inputs: {
          figure: { node: "11", input: "image" },
          template: { node: "12", input: "image" },
          prompt: { node: "100", input: "value" },
          width: { node: "20", input: "width", cast: (v) => Math.round(v / 16) * 16 },
          height: { node: "20", input: "height", cast: (v) => Math.round(v / 16) * 16 },
          steps: { node: "7", input: "steps", cast: Number },
          seed: { node: "7", input: "seed", cast: Number },
        },
        required: ["figure", "prompt"],
        dropWhenEmpty: { template: ["12"] },
        defaults: { steps: 16 },
        params: ["ar", "seed", "steps"],
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
    sys: (v) => SHOOT_SYS(v.mode, v.slate),
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
      /* AND THE CELL SAYS AUTO - Babe, 2026-10-29: "instead of adaptive for
       * AR just make it read AUTO". `adaptive` is the node's word for it and
       * AUTO is everyone's, and this row already has the apparatus for the
       * difference: the cell carries what a person reads and the cast is what
       * goes on the wire, which is how a bare ratio reaches a
       * ResolutionSelector that only answers to "16:9 (Widescreen)".
       * IT IS ALSO THE WORD THIS PAGE ALREADY USES FOR THE SAME IDEA - 04's
       * dials say AUTO for the absence of an answer and 06's DUR says it with
       * no clip. A second word for one thing is one of them wrong. */
      ar: { node: "9", input: "model.ratio",
            cast: (v) => String(v).toUpperCase() === "AUTO" ? "adaptive" : v },
      size: { node: "9", input: "model.resolution" },
      duration: { node: "9", input: "model.duration", cast: Number },
      seed: { node: "9", input: "seed", cast: Number },
    },
    required: ["board", "prompt"],
    defaults: { duration: 5, ar: "AUTO", size: "1080p" },
    /* ITS VOCABULARY IS ITS OWN: no 2:3 and no 3:2, and an `adaptive` nothing
     * else on the rail has. Seedance 2.5 stops at 1080p - 4k is the 2.0
     * node's - so the list is the three the model will take. */
    options: { ar: ["AUTO", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
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
      /* AND SEQUENCE IS ONE PICTURE, which is the board - Babe, 2026-10-30:
       * "sequence is just an image like a board, its still image to video
       * but its prompting it differently like an edit". The sheet rode along
       * here because the base spec takes one and nothing said otherwise, so
       * the panel drew two cells on this row and one on every other - and
       * the six panels already carry the character six times, which makes a
       * sheet on top a second answer to a question the board has answered.
       * THE MODE CHANGES THE PROMPTING, NOT THE INPUT COUNT. */
      seq: { drop: ["3"] },
      transition: {
        graph: "seedance25-flf.json",
        sys:
          "@image1 is the frame the shot opens on and @image2 is the frame it "
          + "ends on. Hold the character, the wardrobe and the lighting exactly as "
          + "those frames have them and do not describe their appearance in words; "
          + "fill the time between them as the direction says.",
        /* AND THE FIRST FRAME IS THE SLATE, NOT A SECOND NAME FOR IT. This
         * was keyed `start`, which is what 04's left slot is called, so the
         * mode asked for a picture this rung has never had a name for -
         * the same shape that made the LTX row answer `needs start` at a
         * slot with a board in it. One key, one cell. */
        inputs: {
          board: { node: "41", input: "image" },
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
        required: ["board", "last", "prompt"],
      },
    },
    variants: {
      /* KLING 4.0, AND IT IS ONE NODE FOR ALL THREE OF THIS RUNG'S TABS -
       * Babe, 2026-10-31: "kling 4 is new btw. we should prob add that as
       * well".
       * `Kling4ImageToVideoNode` takes up to ten keyframes and spaces the
       * middles evenly by itself: a first, up to eight middles, a last. So
       * SINGLE SHOT is the first alone, TRANSITION is the first and the last,
       * and SEQUENCE is the board's six panels in order - three jobs, one
       * graph, and the modes drop the loaders they do not use.
       * NO AR CELL ON THE IMAGE NODE, which is the node's own doing: it takes
       * the aspect ratio of the first keyframe, so a ratio asked for here
       * would be a control that does nothing. The TEXT node has one, because
       * there is no keyframe to take it from - which is the clearest case yet
       * for `swapWhenEmpty` carrying `params` as well as a graph.
       * 720p OR 1080p AND NOTHING ELSE. Every other row on this rung offers
       * 480p; this one does not have it, which is exactly what `options` is
       * for. */
      "KLING-4.0": {
        graph: "kling4-i2v.json",
        label: "Put them in motion",
        sys: () => KLING_SHOT_SYS(),
        firstFrame: true,
        /* the middles and the last frame are SEQUENCE's and TRANSITION's */
        drop: ["11", "21", "22", "23", "24"],
        inputs: {
          board: { node: "10", input: "image" },
          prompt: { node: "1", input: "model.prompt" },
          size: { node: "1", input: "model.resolution" },
          duration: { node: "1", input: "model.duration", cast: Number },
          seed: { node: "1", input: "model.seed", cast: Number },
        },
        required: ["prompt"],
        /* with nothing in the slot this rung is text-to-video, and on this
         * row that is a different NODE rather than the same one with a
         * loader gone - so the whole spec is swapped. */
        dropWhenEmpty: { board: ["10"] },
        swapWhenEmpty: {
          board: {
            graph: "kling4-t2v.json",
            sys: () => KLING_T2V_SYS(),
            firstFrame: false,
            drop: [],
            dropWhenEmpty: {},
            inputs: {
              prompt: { node: "1", input: "model.prompt" },
              ar: { node: "1", input: "model.aspect_ratio" },
              size: { node: "1", input: "model.resolution" },
              duration: { node: "1", input: "model.duration", cast: Number },
              seed: { node: "1", input: "model.seed", cast: Number },
            },
            required: ["prompt"],
            params: ["ar", "size", "duration", "seed"],
            /* the text node has no `adaptive` - there is nothing to adapt to */
            options: { ar: ["16:9", "9:16", "1:1", "21:9"],
                       size: ["720p", "1080p"], duration: KLING_SECS },
            defaults: { ar: "16:9", size: "720p", duration: 5 },
          },
        },
        params: ["size", "duration", "seed"],
        options: { size: ["720p", "1080p"], duration: KLING_SECS },
        defaults: { size: "720p", duration: 5 },
        modes: {
          /* SIX PANELS, SIX KEYFRAMES, IN ORDER. The page already cuts the
           * board and uploads the panels for the rows that can anchor them;
           * this one takes them as its own keyframes, so nothing new is cut
           * and the model is never shown the page.
           * AND `firstFrame` IS FALSE HERE, explicitly: this mode is not
           * handed the board, it is handed its panels, so the rule that
           * keeps a first-frame row off a tab handing over a grid does not
           * apply to it. */
          seq: {
            sys: (v) => KLING_SEQ_SYS(v.panels),
            firstFrame: false,
            drop: [],
            dropWhenEmpty: {},
            swapWhenEmpty: {},
            inputs: {
              panel1: { node: "10", input: "image" },
              panel2: { node: "21", input: "image" },
              panel3: { node: "22", input: "image" },
              panel4: { node: "23", input: "image" },
              panel5: { node: "24", input: "image" },
              panel6: { node: "11", input: "image" },
              prompt: { node: "1", input: "model.prompt" },
              size: { node: "1", input: "model.resolution" },
              duration: { node: "1", input: "model.duration", cast: Number },
              seed: { node: "1", input: "model.seed", cast: Number },
            },
            required: ["panel1", "panel2", "panel3", "panel4", "panel5",
                       "panel6", "prompt"],
          },
          /* TWO ENDS AND THE MIDDLE IS OPEN - the same job TRANSITION does on
           * the H3 rows, on a node that was built for it. */
          transition: {
            sys: () => KLING_FLF_SYS(),
            firstFrame: true,
            drop: ["21", "22", "23", "24"],
            dropWhenEmpty: {},
            swapWhenEmpty: {},
            inputs: {
              board: { node: "10", input: "image" },
              last: { node: "11", input: "image" },
              prompt: { node: "1", input: "model.prompt" },
              size: { node: "1", input: "model.resolution" },
              duration: { node: "1", input: "model.duration", cast: Number },
              seed: { node: "1", input: "model.seed", cast: Number },
            },
            required: ["board", "last", "prompt"],
          },
        },
      },
      /* AND THIS ROW COULD ONLY EVER REFUSE. Its input was keyed `start`,
       * which is what 04's left slot was called before the six - this rung's
       * is `board`, so the one picture the graph needs never arrived and the
       * row answered "needs start" to a slot with a board in it. Found by the
       * free sweep, not by spending on it.
       * AND IT TAKES THE SAME SENTENCE, because it is handed the same grid. */
      /* AND LTX TAKES A RATIO AND A SIZE AFTER ALL, 2026-10-29. The note on
       * the slide said it took neither and hid both cells, which was true of
       * what was WIRED rather than of the graph: node 403 is a
       * `ResolutionSelector` whose two outputs feed the width and height
       * primitives that size the latent. It speaks the same labelled
       * vocabulary H3 does, so it takes the same two casts and the row reads
       * as a plain ratio on all three models. */
      /* FLUX 3 MAX, THE PARTNER ROW THAT DOES BOTH OF THIS RUNG'S JOBS -
       * see FLUX3_SYS. One node, one graph, and the mode decides how many
       * keyframes go into it: the slate alone opens the clip, or the board's
       * six panels are spread across it in order.
       * THE LOADERS ARE DROPPED RATHER THAN LEFT EMPTY. A LoadImage with no
       * filename is a job that fails at Comfy, so the five extra ones go out
       * of the graph on every tab but SEQUENCE - and taking a node out takes
       * every reference to it out too, which is what makes one graph serve
       * both shapes.
       * AND `placement` IS LEFT ON ITS DEFAULT. "spread across the clip" puts
       * the first picture at the start, the last at the end and the rest
       * evenly between - which is exactly what the anchors do on H3 and
       * exactly what 04's board means, so the times the node also offers
       * would be a second way to say the same thing. */
      "FLUX-3-MAX": {
        /* AND ONLY SEEDANCE HAS A FIRST-AND-LAST FRAME, so the rows
         * that do not are pinned off that tab rather than silently
         * falling through to their own base spec - a tab promising
         * a job the graph has no way to do, which is the shape 06
         * already found on MINIMAX-H3 and EDIT.
         * AND THIS ROW GREW ONE, 2026-11-01 - Babe: "believe i can do first
         * and last frame too (transition)". The note above named this row by
         * name as the next one to take the tab, and the node's own words are
         * the whole answer: "one image opens it, TWO become its first and
         * last frame". Nothing new is wired - the keyframe loaders are
         * already there and the mode is the first two of them. */
        only: ["shot", "seq", "transition"],
        graph: "flux3-max-i2v.json",
        model: "FLUX-3-MAX",
        label: "Put them in motion",
        sys: (v) => FLUX3_SYS(v.mode, v.slate),
        /* one keyframe IS the opening frame, which is what this node does
         * with a single picture - so a board slate cannot come here, and
         * SEQUENCE turns it off because there the pictures are the shots. */
        firstFrame: true,
        inputs: {
          board: { node: "17", input: "image" },
          prompt: { node: "16", input: "prompt" },
          /* ITS OWN VOCABULARY AGAIN: an `auto` that follows the first
           * picture, a 2:1 nothing else on the rail offers, and no 2:3 or
           * 3:2. The cell reads AUTO like every other row that has one. */
          ar: { node: "16", input: "aspect_ratio",
                cast: (v) => String(v).toUpperCase() === "AUTO" ? "auto" : v },
          size: { node: "16", input: "resolution" },
          /* a COMBO of strings, not a number - 5 through 20 */
          duration: { node: "16", input: "duration", cast: String },
          seed: { node: "16", input: "seed", cast: Number },
        },
        required: ["board", "prompt"],
        defaults: { duration: "5", ar: "AUTO", size: "720p" },
        options: { ar: ["AUTO", "21:9", "2:1", "16:9", "4:3", "1:1", "3:4", "9:16"],
                   size: ["720p", "1080p"],
                   duration: ["5", "8", "10", "15", "20"] },
        params: ["ar", "size", "duration", "seed"],
        drop: ["18", "19", "20", "21", "22"],
        modes: {
          /* TWO KEYFRAMES ARE THE TWO ENDS, which is what this node does
           * with exactly two pictures - so the mode is the first two
           * loaders and the other four go. The keys are the rung's own:
           * `board` is the slate whatever the tab, and `last` is the frame
           * it ends on, the same pair Seedance and Kling already use. */
          transition: {
            firstFrame: true,
            drop: ["19", "20", "21", "22"],
            inputs: {
              board: { node: "17", input: "image" },
              last: { node: "18", input: "image" },
              prompt: { node: "16", input: "prompt" },
              ar: { node: "16", input: "aspect_ratio",
                    cast: (v) => String(v).toUpperCase() === "AUTO" ? "auto" : v },
              size: { node: "16", input: "resolution" },
              duration: { node: "16", input: "duration", cast: String },
              seed: { node: "16", input: "seed", cast: Number },
            },
            required: ["board", "last", "prompt"],
          },
          /* THE SIX PANELS ARE THE KEYFRAMES, in order, and nothing is
           * dropped - which is the whole of the difference between this
           * rung's two machines on this row. */
          seq: {
            firstFrame: false,
            drop: [],
            inputs: {
              panel1: { node: "17", input: "image" },
              panel2: { node: "18", input: "image" },
              panel3: { node: "19", input: "image" },
              panel4: { node: "20", input: "image" },
              panel5: { node: "21", input: "image" },
              panel6: { node: "22", input: "image" },
              prompt: { node: "16", input: "prompt" },
              ar: { node: "16", input: "aspect_ratio",
                    cast: (v) => String(v).toUpperCase() === "AUTO" ? "auto" : v },
              size: { node: "16", input: "resolution" },
              duration: { node: "16", input: "duration", cast: String },
              seed: { node: "16", input: "seed", cast: Number },
            },
            required: ["panel1", "panel6", "prompt"],
          },
        },
      },
      /* FLUX 3, THE TIER BELOW MAX - Babe, 2026-11-01: "yeah would like flux
       * 3". Same three jobs on the same shape of node, so the row is the Max
       * entry with four differences the catalog names: no `reasoning_level`,
       * a `safety_tolerance` instead, resolutions up to 2160p, and an `auto`
       * duration. THE PICKER IS WHY IT IS A SECOND ROW RATHER THAN A CELL:
       * a model is a row on this rail and a tier is a model - Krea and Nano
       * are not a quality slider either.
       * AND IT TEXT-TO-VIDEOS THE WAY KLING DOES, which is a different CLASS
       * rather than the same node with its loaders gone - so `swapWhenEmpty`
       * is the mechanism, exactly as it is there.
       * (*) 05 NOW HOLDS SEVEN ROWS, which is the longest picker on the rail
       * and already flagged as too long at six. The menu holds the
       * ALTERNATIVES, so six is what it draws and the cap is untouched - but
       * the cut, when it comes, is Babe's. */
      "FLUX-3": {
        only: ["shot", "seq", "transition"],
        graph: "flux3-i2v.json",
        model: "FLUX-3",
        label: "Put them in motion",
        sys: (v) => FLUX3_SYS(v.mode, v.slate),
        firstFrame: true,
        inputs: {
          board: { node: "17", input: "image" },
          prompt: { node: "16", input: "prompt" },
          ar: { node: "16", input: "aspect_ratio",
                cast: (v) => String(v).toUpperCase() === "AUTO" ? "auto" : v },
          size: { node: "16", input: "resolution" },
          duration: { node: "16", input: "duration", cast: String },
          seed: { node: "16", input: "seed", cast: Number },
        },
        required: ["board", "prompt"],
        defaults: { duration: "5", ar: "AUTO", size: "720p" },
        options: { ar: ["AUTO", "21:9", "2:1", "16:9", "4:3", "1:1", "3:4", "9:16"],
                   /* 1440p and 2160p are this tier's and not Max's, which is
                    * the one cell where the cheaper row offers MORE. */
                   size: ["720p", "1080p", "1440p", "2160p"],
                   duration: ["5", "8", "10", "15", "20"] },
        params: ["ar", "size", "duration", "seed"],
        drop: ["18", "19", "20", "21", "22"],
        /* with nothing in the slate this is text-to-video, which is its own
         * node - a dropped loader cannot become another class. */
        swapWhenEmpty: {
          board: {
            graph: "flux3-t2v.json",
            firstFrame: false,
            drop: [],
            dropWhenEmpty: {},
            inputs: {
              prompt: { node: "16", input: "prompt" },
              ar: { node: "16", input: "aspect_ratio",
                    cast: (v) => String(v).toUpperCase() === "AUTO" ? "auto" : v },
              size: { node: "16", input: "resolution" },
              duration: { node: "16", input: "duration", cast: String },
              seed: { node: "16", input: "seed", cast: Number },
            },
            required: ["prompt"],
          },
        },
        modes: {
          /* the two ends, the same pair of keys the rest of this rung uses */
          transition: {
            firstFrame: true,
            drop: ["19", "20", "21", "22"],
            swapWhenEmpty: {},
            inputs: {
              board: { node: "17", input: "image" },
              last: { node: "18", input: "image" },
              prompt: { node: "16", input: "prompt" },
              ar: { node: "16", input: "aspect_ratio",
                    cast: (v) => String(v).toUpperCase() === "AUTO" ? "auto" : v },
              size: { node: "16", input: "resolution" },
              duration: { node: "16", input: "duration", cast: String },
              seed: { node: "16", input: "seed", cast: Number },
            },
            required: ["board", "last", "prompt"],
          },
          /* the six panels are the keyframes, in order */
          seq: {
            firstFrame: false,
            drop: [],
            swapWhenEmpty: {},
            inputs: {
              panel1: { node: "17", input: "image" },
              panel2: { node: "18", input: "image" },
              panel3: { node: "19", input: "image" },
              panel4: { node: "20", input: "image" },
              panel5: { node: "21", input: "image" },
              panel6: { node: "22", input: "image" },
              prompt: { node: "16", input: "prompt" },
              ar: { node: "16", input: "aspect_ratio",
                    cast: (v) => String(v).toUpperCase() === "AUTO" ? "auto" : v },
              size: { node: "16", input: "resolution" },
              duration: { node: "16", input: "duration", cast: String },
              seed: { node: "16", input: "seed", cast: Number },
            },
            required: ["panel1", "panel6", "prompt"],
          },
        },
      },
      "LTX-2.5 I2V": {
        /* AND ONLY SEEDANCE HAS A FIRST-AND-LAST FRAME, so the rows
         * that do not are pinned off that tab rather than silently
         * falling through to their own base spec - a tab promising
         * a job the graph has no way to do, which is the shape 06
         * already found on MINIMAX-H3 and EDIT. Add "transition"
         * here the day a row grows one: Pika and H3 both carry
         * `first_frame` and `last_frame` on the fl2va checkpoint,
         * and FLUX 3 Image to Video takes two keyframes. */
        only: ["shot", "seq"],
        graph: "ltx25-i2v.json",
        label: "Put them in motion",
        /* AND THE PICTURE IT IS GIVEN BECOMES FRAME ONE - Babe, 2026-10-29:
         * "for ltx i just uses a single image". `LTXVImgToVideoInplace` is
         * the whole machine, so whatever is in the slate is what the clip
         * OPENS on - which is why a board cannot be sent here and why
         * SEQUENCE drops this row. It is a fact about the graph rather than
         * about any one tab, so it is declared with the graph. */
        firstFrame: true,
        sys: (v) => SHOOT_SYS(v.mode, v.slate),
        inputs: {
          board: { node: "395", input: "image" },
          prompt: { node: "398:376", input: "value" },
          ar: { node: "403", input: "aspect_ratio", cast: (v) => AR_LABEL[v] || v },
          size: { node: "403", input: "megapixels", cast: (v) => AR_MP[v] || Number(v) || 0.9 },
          duration: { node: "398:362", input: "value", cast: Number },
          seed: { node: "398:339", input: "noise_seed", cast: Number },
        },
        required: ["board", "prompt"],
        defaults: { duration: 5, ar: "16:9", size: "720p" },
        params: ["ar", "size", "duration", "seed"],
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
        /* AND ONLY SEEDANCE HAS A FIRST-AND-LAST FRAME, so the rows
         * that do not are pinned off that tab rather than silently
         * falling through to their own base spec - a tab promising
         * a job the graph has no way to do, which is the shape 06
         * already found on MINIMAX-H3 and EDIT. Add "transition"
         * here the day a row grows one: Pika and H3 both carry
         * `first_frame` and `last_frame` on the fl2va checkpoint,
         * and FLUX 3 Image to Video takes two keyframes. */
        only: ["shot", "seq", "transition"],
        graph: "minimax-h3-r2v.json",
        model: "MINIMAX-H3",
        label: "Put them in motion",
        sys: (v) => H3_R2V_SYS(v.mode, !!v.sheet, v.slate),
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
          /* THE LIGHTNING SWITCH IS A CELL NOW - Babe, 2026-10-29: "i dont
           * want the 4step lora", then, having run both, "turbo is worse".
           * ONE BOOLEAN PICKS BOTH HALVES. 146 drives two `ComfySwitchNode`s
           * at once: true takes the model through the 4-step `ref2v` turbo
           * LoRA and sets the scheduler to 4, false takes the base UNET and
           * sets it to 20. So a STEPS cell of 4 or 20 is the honest way to
           * say it - this file has had a (*) asking for exactly that since
           * the row was wired, on the suspicion that the LoRA was what made
           * the audio weak.
           * IT DEFAULTS TO 20, because a row somebody is judging a model by
           * should be the model. */
          steps: { node: "146", input: "value", cast: (v) => Number(v) <= 4 },
          /* HOW MUCH OF THE REFERENCE THE MODEL ACTUALLY LOOKS AT, which is
           * the first cell on this rail that is about an INPUT rather than
           * about what comes out. The node's own words: `match` scales each
           * reference DOWN to the generation's pixel area, `max` uses the
           * reference pipeline's 2048px short edge "for best identity
           * fidelity", and "reference tokens ride through every sampling
           * step, so 'max' can be several times slower".
           * AND THE SHEET IS WHY IT MATTERS HERE. 05 sends a CONTACT SHEET as
           * <Picture 2>, so `match` at 720p scales four panels into about one
           * megapixel - a quarter of that each, and the face inside a panel
           * down to a couple of hundred pixels. It is rung 01's own lesson
           * arriving on a reference: a figure at a small size puts the face
           * in forty pixels, and the face is the whole of what the sheet is
           * carrying.
           * IT IS A CELL AND NOT A GRAPH VALUE, which is the STEPS precedent
           * on this same row: a speed-for-quality trade belongs to whoever is
           * waiting in front of it. IT DEFAULTS TO FIT, so nothing changes
           * until somebody presses it and the demo stays as fast as it was.
           * (*) THE LABEL AND BOTH WORDS ARE MINE and Babe's to cut. The node
           * says match/max; FIT reads as a thing done to a picture where
           * MATCH reads as a question about whether two things are the same. */
          refsize: { node: "136", input: "ref_image_size",
                     cast: (v) => String(v).toLowerCase() === "max" ? "max" : "match" },
          seed: { node: "129", input: "noise_seed", cast: Number },
        },
        required: ["board", "prompt"],
        defaults: { duration: 5, ar: "16:9", size: "720p", steps: 20, refsize: "FIT" },
        /* AND ITS SECONDS ARE ITS OWN, read off the node rather than off the
         * rung: `length` is frames at 24fps and the tooltip gives the trained
         * range as ~124 to ~362, which is 5.2s to 15.1s. So 4 is BELOW THE
         * FLOOR - the graph's own expression rounds it onto the 17-frame
         * block grid anyway, which is why a 4-second ask came back 4.5 - and
         * 15 is inside a range nothing on this row could reach. */
        options: { duration: H3_SECS, steps: ["4", "20"] },
        /* the sheet takes its loader with it, and the reference slot on the
         * conditioning node goes when the loader does - `<Picture 2>` stops
         * being named by the sentence in the same breath, because `sys` reads
         * the values the drops were taken out of. */
        dropWhenEmpty: { sheet: ["139"] },
        /* AND NO `adaptive` HERE: this row builds its own latent, so there is
         * nothing for a ratio to adapt TO - the shape has to be stated. The
         * eight the cell already offers are exactly the eight the node takes. */
        params: H3_CELLS.concat("refsize"),
        /* AND THE MODE PICKS THE MACHINE, EACH WITH ITS OWN GRAPH - Babe,
         * 2026-10-29: "should we just build it like four so you do single
         * shot or video sequence", "so its wired correctly on the back-end",
         * "each should have their own json".
         * THREE JOBS, THREE CHECKPOINTS, AND THE PRESS SAYS WHICH. The row
         * ran one machine for all of them - `ref2va`, which CONDITIONS on
         * whatever it is handed - so a board came back smeared through the
         * shot rather than used or ignored. A single frame wants to be the
         * FIRST frame, and a board wants to be the shots themselves. */
        modes: {
          /* THE SLATE IS THE FIRST FRAME. `fl2va` weights, and its own turbo
           * is the 8-step `fl2v` one rather than `ref2v`'s 4 - do not cross
           * the LoRAs. No sheet: this machine takes one picture and the
           * likeness is already in it. */
          shot: {
            graph: "minimax-h3-i2v.json",
            /* and with nothing in the slot this is text to video - the
               loader goes, the node takes no first frame, and the sentence
               stops describing one. */
            sys: (v) => (v.blank.board
              ? H3_T2V_SYS(v.mode) : H3_I2V_SYS(v.mode)),
            /* the same thing LTX does, which is what this tab IS */
            firstFrame: true,
            /* AND THE TURBO ON THIS MACHINE IS EIGHT STEPS, NOT FOUR. Node
             * 146 switches the same way on all three graphs and what it
             * switches to is not the same thing: `ref2v` is the 4-step LoRA
             * on the reference weights and `fl2v` is the 8-step one on these,
             * with node 144 reading 8 to prove it. The cell inherited the
             * reference row's list and so SAID 4 WHILE 8 RAN - a readout off
             * by a factor on two of three tabs, which is the box lying about
             * what it holds arriving in the param row. The cast was already
             * written `<= 8`, as though the list were going to follow. */
            options: { duration: H3_SECS, steps: ["8", "20"] },
            /* AND NO REF CELL: `ref_image_size` is the reference node's and
             * this machine encodes the picture as a first frame, so there is
             * no reference pipeline to size. */
            /* AND THE LAST-FRAME LOADER GOES, because this graph grew one
             * for the transition tab and a `LoadImage` with no file in it is
             * a job that fails at Comfy. It was already going, by the row's
             * `sheet` drop happening to name the same node - accidental
             * correctness, which is the kind that breaks later. */
            drop: ["139"],
            params: H3_CELLS,
            inputs: {
              board: { node: "137", input: "image" },
          prompt: { node: "138", input: "value" },
          ar: { node: "115", input: "aspect_ratio", cast: (v) => AR_LABEL[v] || v },
          size: { node: "115", input: "megapixels", cast: (v) => AR_MP[v] || Number(v) || 0.98 },
          duration: { node: "132", input: "value", cast: Number },
          steps: { node: "146", input: "value", cast: (v) => Number(v) <= 8 },
          seed: { node: "129", input: "noise_seed", cast: Number },
            },
            required: ["prompt"],
            dropWhenEmpty: { board: ["137"] },
          },
          /* AND THE SAME MACHINE TAKES THE OTHER END OF THE SHOT. One more
           * `LoadImage` on the node's own optional `last_frame`, which is
           * `firstFrame` still: the slate opens the clip either way. */
          transition: {
            graph: "minimax-h3-i2v.json",
            sys: () => H3_FLF_SYS(),
            firstFrame: true,
            options: { duration: H3_SECS, steps: ["8", "20"] },
            params: H3_CELLS,
            inputs: {
              board: { node: "137", input: "image" },
              last: { node: "139", input: "image" },
              prompt: { node: "138", input: "value" },
              ar: { node: "115", input: "aspect_ratio", cast: (v) => AR_LABEL[v] || v },
              size: { node: "115", input: "megapixels", cast: (v) => AR_MP[v] || Number(v) || 0.98 },
              duration: { node: "132", input: "value", cast: Number },
              steps: { node: "146", input: "value", cast: (v) => Number(v) <= 8 },
              seed: { node: "129", input: "noise_seed", cast: Number },
            },
            /* AND A DROP IS A NODE ADDRESS, SO A MODE THAT CHANGES THE
             * GRAPH CHANGES WHAT IT MEANS. The row's `dropWhenEmpty` maps
             * `sheet` to node 139, which is the sheet loader in the r2v
             * graph - and 139 is the LAST FRAME in this one, so the
             * transition inherited a rule that deleted the second half of
             * its own job. Caught by a dry run reading `MISSING node 139`
             * under `last`. Nothing here is optional, so it inherits none
             * of it. */
            dropWhenEmpty: {},
            /* THE SECOND FRAME IS THE JOB, so it refuses without one rather
             * than quietly running the single-shot job under another name. */
            required: ["board", "last", "prompt"],
          },
          /* AND THE BOARD BECOMES THE TIMELINE. Six panels, six anchors,
           * chained `MiniMaxH3AddGuide`s - so the grid never reaches the
           * model and its panels do, one at a time, at the frame each one
           * happens on. The client cuts them out of the board it drew; `at1`
           * to `at6` are the frames they land on.
           * ALL SIX ARE REQUIRED, because dropping one would break the chain
           * the next guide hangs off - this is the one place on the rail
           * where `dropWhenEmpty` cannot help, and the board always has six. */
          seq: {
            graph: "minimax-h3-board.json",
            sys: () => H3_BOARD_SYS(),
            /* the same 8-step `fl2v` turbo as SINGLE SHOT - see there, and
               no REF cell there either: the panels arrive as guides */
            options: { duration: H3_SECS, steps: ["8", "20"] },
            params: H3_CELLS,
            inputs: {
          panel1: { node: "200", input: "image" },
          at1: { node: "210", input: "value", cast: Number },
          panel2: { node: "201", input: "image" },
          at2: { node: "211", input: "value", cast: Number },
          panel3: { node: "202", input: "image" },
          at3: { node: "212", input: "value", cast: Number },
          panel4: { node: "203", input: "image" },
          at4: { node: "213", input: "value", cast: Number },
          panel5: { node: "204", input: "image" },
          at5: { node: "214", input: "value", cast: Number },
          panel6: { node: "205", input: "image" },
          at6: { node: "215", input: "value", cast: Number },
          prompt: { node: "138", input: "value" },
          ar: { node: "115", input: "aspect_ratio", cast: (v) => AR_LABEL[v] || v },
          size: { node: "115", input: "megapixels", cast: (v) => AR_MP[v] || Number(v) || 0.98 },
          duration: { node: "132", input: "value", cast: Number },
          steps: { node: "146", input: "value", cast: (v) => Number(v) <= 8 },
          seed: { node: "129", input: "noise_seed", cast: Number },
            },
            required: ["panel1", "panel6", "prompt"],
          },
        },
      },
      /* PIKA H3 FLEX - a Pika post-trained ADAPTER for the MiniMax H3 Ref2VA
       * weights this row already runs, dropped 2026-10-29 and wired the same
       * evening. Babe: "i guess its a fine-tune", "supposed to be faster
       * too", "also open weights".
       * IT IS THE SAME GRAPH WITH THREE VALUES MOVED, which is why it is a
       * row and not a mechanism: the same int8 Ref2VA base, the same VAEs,
       * the same encoder and the same `MiniMaxH3ReferenceToVideo`, with the
       * Pika adapter at strength 1.0 on the `lcm` sampler and Pika's own
       * six-value sigma list. SIX STEPS against the base's twenty.
       * AND THAT IS WHY IT EARNS A SEAT BESIDE THE ROW IT IS BUILT ON. Babe
       * ran this rung's own 4-step turbo and cut it - "i dont want the 4step
       * lora", "turbo is worse" - so the row defaults to 20 and a minute of
       * waiting. A Pika post-train is not that distillation: it is a
       * different fine-tune of the same weights, so whether six of its steps
       * beat twenty of the base's is a question the picker can now ask.
       * THE STEPS CELL IS GONE, and that is the sigma list rather than a
       * decision. `BasicScheduler` took a count and derived a curve; this
       * graph states seven sigmas outright, so the two switches that chose
       * between the base and a turbo have nothing left to choose and the
       * count is not an input any more. A cell that does nothing is worse
       * than no cell - Mage-Flow's own missing STEPS, one rung over.
       * AND IT HAS NO `only`: every tab on this rung has a Pika machine
       * behind it, which is the `modes` block below and the comment on it.
       * Their T2V adapter is wired nowhere and should stay that way - never
       * route a shot with a person through text-to-video. */
      "PIKA-H3-FLEX": {
        /* AND ONLY SEEDANCE HAS A FIRST-AND-LAST FRAME, so the rows
         * that do not are pinned off that tab rather than silently
         * falling through to their own base spec - a tab promising
         * a job the graph has no way to do, which is the shape 06
         * already found on MINIMAX-H3 and EDIT. Add "transition"
         * here the day a row grows one: Pika and H3 both carry
         * `first_frame` and `last_frame` on the fl2va checkpoint,
         * and FLUX 3 Image to Video takes two keyframes. */
        only: ["shot", "seq", "transition"],
        graph: "pika-h3-flex-r2v.json",
        model: "PIKA-H3-FLEX",
        label: "Put them in motion",
        /* THE SAME SENTENCE THE ROW IT IS BUILT ON GETS. The node is the
         * same class and reads the same `<Picture N>` addressing, so a
         * scaffolding written for it is written for this - a second copy
         * could only drift from the one that is proven. */
        sys: (v) => H3_R2V_SYS(v.mode, !!v.sheet, v.slate),
        inputs: {
          board: { node: "137", input: "image" },
          sheet: { node: "139", input: "image" },
          prompt: { node: "138", input: "value" },
          ar: { node: "115", input: "aspect_ratio", cast: (v) => AR_LABEL[v] || v },
          size: { node: "115", input: "megapixels", cast: (v) => AR_MP[v] || Number(v) || 0.98 },
          duration: { node: "132", input: "value", cast: Number },
          refsize: { node: "136", input: "ref_image_size",
                     cast: (v) => String(v).toLowerCase() === "max" ? "max" : "match" },
          seed: { node: "129", input: "noise_seed", cast: Number },
        },
        required: ["board", "prompt"],
        defaults: { duration: 5, ar: "16:9", size: "720p", refsize: "FIT" },
        options: { duration: H3_SECS },
        dropWhenEmpty: { sheet: ["139"] },
        /* H3_CELLS MINUS STEPS, which is the one cell this adapter took away */
        params: ["ar", "size", "duration", "refsize", "seed"],
        /* AND THE MODE PICKS THE MACHINE HERE TOO, because Pika shipped an
         * adapter per BASE and not per template. The row above runs three
         * checkpoints across its three tabs and Pika post-trained two of
         * them: `ref2va` for CUSTOM and `fl2va` for the other two, which is
         * the same checkpoint SINGLE SHOT and SEQUENCE have always run. So
         * every tab has a Pika machine behind it and this row needs no
         * `only` at all - Babe, asked: "maybe it should show for single shot
         * and sequence too, no?".
         * THE FIRST VERSION PINNED IT TO CUSTOM ON A WRONG READING OF THE
         * CATALOGUE. Pika ship three TEMPLATES - t2v, ref2va and an FL2VA
         * that animates between a first and a last frame - and reading the
         * templates as the offering says this rung has one Pika job in it.
         * The adapter is not the template: `pika_h3_flex_fl2va_v1` loads
         * onto `minimax_h3_fl2va_pruned_int8_convrot`, our own SINGLE SHOT
         * and SEQUENCE weights, and `MiniMaxH3ImageToVideo` takes
         * `first_frame` and `last_frame` as OPTIONAL inputs - so one picture
         * is as valid as two, and a board of six guides is the same node
         * with the frames hung off it.
         * ASK WHAT A LORA LOADS ONTO, NOT WHAT ITS DEMO DOES. */
        modes: {
          /* the slate as the first frame, on the `fl2va` adapter - and DO
           * NOT CROSS THE LORAS, which now has a second family to get wrong:
           * `pika_h3_flex_ref2va` belongs to the reference weights above and
           * this one to these. */
          shot: {
            graph: "pika-h3-flex-i2v.json",
            /* and with nothing in the slot this is text to video - the
               loader goes, the node takes no first frame, and the sentence
               stops describing one. */
            sys: (v) => (v.blank.board
              ? H3_T2V_SYS(v.mode) : H3_I2V_SYS(v.mode)),
            firstFrame: true,
            /* no REF cell: this machine encodes the picture as a first frame,
             * so there is no reference pipeline to size - the row above says
             * the same thing on the same tab */
            /* AND THE LAST-FRAME LOADER GOES, because this graph grew one
             * for the transition tab and a `LoadImage` with no file in it is
             * a job that fails at Comfy. It was already going, by the row's
             * `sheet` drop happening to name the same node - accidental
             * correctness, which is the kind that breaks later. */
            drop: ["139"],
            params: ["ar", "size", "duration", "seed"],
            options: { duration: H3_SECS },
            inputs: {
              board: { node: "137", input: "image" },
              prompt: { node: "138", input: "value" },
              ar: { node: "115", input: "aspect_ratio", cast: (v) => AR_LABEL[v] || v },
              size: { node: "115", input: "megapixels", cast: (v) => AR_MP[v] || Number(v) || 0.98 },
              duration: { node: "132", input: "value", cast: Number },
              seed: { node: "129", input: "noise_seed", cast: Number },
            },
            required: ["prompt"],
            dropWhenEmpty: { board: ["137"] },
          },
          /* and the other end of the shot, on the same machine - see the row
           * above: `last_frame` is this node's own optional second input. */
          transition: {
            graph: "pika-h3-flex-i2v.json",
            sys: () => H3_FLF_SYS(),
            firstFrame: true,
            params: ["ar", "size", "duration", "seed"],
            options: { duration: H3_SECS },
            inputs: {
              board: { node: "137", input: "image" },
              last: { node: "139", input: "image" },
              prompt: { node: "138", input: "value" },
              ar: { node: "115", input: "aspect_ratio", cast: (v) => AR_LABEL[v] || v },
              size: { node: "115", input: "megapixels", cast: (v) => AR_MP[v] || Number(v) || 0.98 },
              duration: { node: "132", input: "value", cast: Number },
              seed: { node: "129", input: "noise_seed", cast: Number },
            },
            /* AND A DROP IS A NODE ADDRESS, SO A MODE THAT CHANGES THE
             * GRAPH CHANGES WHAT IT MEANS. The row's `dropWhenEmpty` maps
             * `sheet` to node 139, which is the sheet loader in the r2v
             * graph - and 139 is the LAST FRAME in this one, so the
             * transition inherited a rule that deleted the second half of
             * its own job. Caught by a dry run reading `MISSING node 139`
             * under `last`. Nothing here is optional, so it inherits none
             * of it. */
            dropWhenEmpty: {},
            required: ["board", "last", "prompt"],
          },
          /* six panels, six anchors, the same chained `MiniMaxH3AddGuide`s -
           * the grid never reaches the model and its panels do, one at a
           * time, at the frame each one happens on. All six are required:
           * dropping one breaks the chain the next guide hangs off. */
          seq: {
            graph: "pika-h3-flex-board.json",
            sys: () => H3_BOARD_SYS(),
            params: ["ar", "size", "duration", "seed"],
            options: { duration: H3_SECS },
            inputs: {
              panel1: { node: "200", input: "image" },
              at1: { node: "210", input: "value", cast: Number },
              panel2: { node: "201", input: "image" },
              at2: { node: "211", input: "value", cast: Number },
              panel3: { node: "202", input: "image" },
              at3: { node: "212", input: "value", cast: Number },
              panel4: { node: "203", input: "image" },
              at4: { node: "213", input: "value", cast: Number },
              panel5: { node: "204", input: "image" },
              at5: { node: "214", input: "value", cast: Number },
              panel6: { node: "205", input: "image" },
              at6: { node: "215", input: "value", cast: Number },
              prompt: { node: "138", input: "value" },
              ar: { node: "115", input: "aspect_ratio", cast: (v) => AR_LABEL[v] || v },
              size: { node: "115", input: "megapixels", cast: (v) => AR_MP[v] || Number(v) || 0.98 },
              duration: { node: "132", input: "value", cast: Number },
              seed: { node: "129", input: "noise_seed", cast: Number },
            },
            required: ["panel1", "panel6", "prompt"],
          },
        },
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
     tab promise a job the graph has no way to do.
     AND IT IS A LIST, BECAUSE A ROW CAN DO TWO OF THE FOUR AND NOT THE REST.
     Babe, 2026-10-30: Pika H3 Flex answers RESHOOT and SWAP - one machine,
     two sentences - and cannot do EDIT or EXTEND, which keep the source
     pixels. A single string could say one job or no opinion at all, and
     neither of those is true of that row. A bare string still means what it
     always did, so nothing that was pinned had to be rewritten.
     THE PIN STILL WINS OVER THE PAGE: a mode this row cannot do falls to the
     first one it can, which is what stops a tab promising a job the graph has
     no way to do. The page's own spelling is kept when it matches, because
     `modes` is keyed in the rung's casing - 05's are `shot` and `seq` - and
     an uppercased lookup would miss every one of them. */
  const pins = spec.only == null ? null
    : (Array.isArray(spec.only) ? spec.only : [spec.only]);
  const pinned = pins && body.mode && pins.some(
    (p) => String(p).toUpperCase() === String(body.mode).toUpperCase());
  const mode = pins ? (pinned ? body.mode : pins[0]) : (body.mode || null);
  if (mode && spec.modes && spec.modes[mode]) {
    spec = { ...spec, ...spec.modes[mode] };
  }

  /* AND A ROW CAN BE A DIFFERENT MACHINE WITH NOTHING IN THE SLOT, which is
   * the one thing `dropWhenEmpty` cannot do - built for Kling 4.0,
   * 2026-10-31.
   * ON NANO, QWEN AND KREA, TEXT-TO-IMAGE IS THE SAME NODE WITH THE LOADER
   * GONE, and on H3 and Pika text-to-video is the same node with the first
   * frame gone - so dropping was the whole of it and no axis was needed.
   * KLING IS THE FORCING CASE: `Kling4TextToVideoNode` is a different class
   * from `Kling4ImageToVideoNode`, with an aspect ratio the image node does
   * not have because that one takes its shape from the first keyframe. A
   * dropped loader cannot become another node.
   * IT IS THE SAME SHALLOW MERGE A MODE GETS, so a swap states what differs
   * and inherits the rest, and it reads against the REQUEST rather than
   * against `values`: a file only ever arrives in the body, never from
   * `defaults`, so this can land before `values` is built and the swapped
   * spec's own defaults are the ones that apply. */
  for (const [key, alt] of Object.entries(spec.swapWhenEmpty || {})) {
    const got = (body.values || {})[key];
    if (got === undefined || got === "") spec = { ...spec, ...alt };
  }

  const values = { ...(spec.defaults || {}), ...(body.values || {}) };

  /* A DEFAULT LOSES TO AN EMPTY STRING. The page sends every field whether or
   * not it holds anything, so `defaults` cannot stand in for a line the
   * artist cleared — `blankTo` is the floor under one that arrives blank. */
  /* AND WHAT ARRIVED BLANK IS REMEMBERED, because `sys` runs after this and
   * cannot otherwise tell a line the artist wrote from the floor under one
   * they did not - 01's floor is a whole sentence ("Become the character in
   * the reference."), so `!!v.prompt` is true on every run by the time the
   * scaffolding is composed. It is the `drops` lesson in the other
   * direction: that one is hoisted ABOVE `sys` so the sentence and the graph
   * agree, and this one has to be remembered BELOW it for the same reason.
   * MEASURED BEFORE IT SHIPPED: the branch that reads this was written
   * against `v.prompt` first, which would have made every STYLE run take the
   * words path and quietly ended RANDOM's costume transfer. */
  /* AND IT IS EVERY KEY THAT ARRIVED EMPTY, not only the ones with a floor
   * declared. Written against `spec.blankTo` first, which looks right and is
   * a fact about THIS SPEC rather than about the request: a variant replaces
   * the base outright, so 01's FLUX row has no `blankTo` at all - and an
   * empty prompt there produced an empty `blank`, which read as "the artist
   * wrote something". Measured by dry run, which is why it never shipped. */
  /* AND IT IS EVERY KEY THIS SPEC HAS AN ADDRESS FOR, not only the ones
   * that turned up. The page sends every field whether or not it holds
   * anything, so reading `values` alone was right for every press - and a
   * key that is simply ABSENT is the same fact about the request, which is
   * what a dry run sends and what any other caller would. `blank.source`
   * read undefined there, the t2i branch never fired, and the sentence and
   * the graph described different jobs: the loaders were gone and the
   * scaffolding was still restyling a person in image 1. */
  const blank = {};
  for (const key of Object.keys(spec.inputs || {})) blank[key] = true;
  for (const [key, val] of Object.entries(values)) {
    blank[key] = val === undefined || val === "";
  }
  /* AND A FLOOR CAN BE A FUNCTION OF THE VALUES, the way `sys` is, because
   * a floor has a PREMISE and the premise can be gone. 01's is "Become the
   * character in the reference." - which names a picture, so on a run with
   * no pictures at all it is a sentence about nothing, and worse, it fills
   * `prompt` and therefore PASSES the required check: a job with no
   * instruction in it, submitted. An empty string is no floor, which leaves
   * `required` to refuse exactly as it would have.
   * IT READS `blank` AND NOT `values`, so it sees what arrived rather than
   * what has since been floored or promoted. */
  for (const [key, v] of Object.entries(spec.blankTo || {})) {
    if (values[key] === undefined || values[key] === "") {
      values[key] = typeof v === "function" ? v({ ...values, blank }) : v;
    }
  }

  /* AND A PICTURE CAN MOVE UP A SLOT WHEN THE ONE ABOVE IT IS EMPTY - built
   * for 01's text-to-image, 2026-10-31.
   *
   * THE PROBLEM IS NUMBERING, NOT WIRING. Drop the source loader and every
   * one of these rows is left holding its reference in the SECOND slot with
   * nothing in the first: qwen keeps `images.image_2`, Krea keeps
   * `model.images.image_1`, nano keeps `model.images.image_2`. Krea's node
   * says outright that its images are "numbered in connection order", so one
   * connected picture is @Image1 whatever socket it sat in - and the sentence
   * would have gone on calling it @Image2. A reference addressed by a name
   * the model does not use is a reference the model is free to average in,
   * which is this rail's oldest and most expensive failure.
   *
   * SO THE VALUE MOVES INTO THE FIRST SLOT'S ADDRESS and the donor key goes,
   * which fires that key's own `dropWhenEmpty` and takes the now-empty
   * loader out. The graph that reaches Comfy is a one-image job, which is
   * exactly what each of these models does with one image.
   *
   * IT IS NOT A FOURTH RESOLUTION AXIS, deliberately. A `noSource` spec
   * merged like a mode would have to restate the whole `inputs` table to
   * move one address - which is the duplicate-key bug this file already
   * paid for on this rung. One line of data beside `dropWhenEmpty`, which
   * it composes with rather than replacing.
   *
   * AND `blank` IS COMPUTED ABOVE THIS, so it still says what ARRIVED
   * empty. That is the whole of how `sys` tells a promoted reference from
   * a real subject: `values.source` is set and `blank.source` is true. */
  /* AND IT COMPACTS RATHER THAN SHIFTING ONE PLACE. One pass moves a
   * picture up by one slot, which was the whole job while a row had two -
   * with three, a reference in the LAST cell and nothing in the first two
   * lands in slot 2 and leaves slot 1 empty, which is the numbering trap
   * this exists to prevent, one cell further along. The passes repeat until
   * nothing moves, bounded by the number of rules there are. */
  const fills = Object.entries(spec.fillWhenEmpty || {});
  for (let pass = 0; pass < fills.length; pass++) {
    let moved = false;
    for (const [key, from] of fills) {
      if (!values[key] && values[from]) {
        values[key] = values[from];
        delete values[from];
        moved = true;
      }
    }
    if (!moved) break;
  }

  /* AND IT IS CHECKED HERE, BEFORE THE SCAFFOLDING IS GLUED ON, 2026-10-31.
   * ON A ROW WITH NO `sys` ADDRESS THE SENTENCE GOES INTO `prompt` - which
   * is every open row on this rail - so by the time this ran, `prompt` was
   * never empty and `required: ["prompt"]` could not fire. This file already
   * had it written down as a hole the page was covering; what made it worth
   * closing is that the hole MOVED: while `source` was required a bare run
   * refused on the picture, and the moment a row could run on words alone
   * the only thing left standing between an empty panel and a submitted job
   * was the one check that could not fire. On Krea that is real money.
   * `blankTo` STAYS ABOVE IT, because a floor is a legitimate answer - and
   * it is a function of the values now, so a floor whose premise is gone
   * returns "" and is refused here exactly as if nobody had typed. */
  for (const key of spec.required) {
    if (values[key] === undefined || values[key] === "") {
      return json(res, 400, { error: `${spec.label} needs ${key}` });
    }
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

  /* `mode` is already the resolved one - a pin where there is one, the page's
     where there is not - so reading `spec.only` again here would only ever
     disagree with it once that field became a list. */
  const seen = { ...values, mode, blank };
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
    /* SIX DIGITS, NOT TEN. A seed is for telling two rerolls apart and for
     * reproducing one, and a million of them does both - what ten digits were
     * costing was a cell wide enough to hold them, on a row that has run out
     * of width. Any integer is still accepted, so a locked seed from before
     * goes on working. */
    values.seed = Math.floor(Math.random() * 1e6);
  }

  /* AND A ROW MAY BE GIVEN A DIFFERENT GUIDE - Babe, 2026-10-29, after Krea
   * came back with a bear BUST: "or on the back-end for that model we just feed
   * it something else like an outline of a portrait".
   * THE WORDS WERE ALREADY THERE AND LOST. `GUIDE_SYS` says "never return a
   * mannequin, a statue, a bust or a figure" and the picture won anyway, which
   * is this rail's own lesson twice over: 02's sheet forbids a gutter and the
   * model draws the one it was SHOWN, 04's board forbids the labels and the
   * model letters them. A model handed a shape copies the shape, and an edit
   * checkpoint that holds structure hard copies it hardest.
   * SO THE PICTURE CHANGES AND THE SENTENCE DOES NOT. An outline has no plinth,
   * no carved shoulders, no material and no light - it carries the crop, the
   * distance, the eye level and the head's share of the frame, which is every
   * single thing `GUIDE_SYS` says to take and none of what it says to refuse.
   * IT IS THE ONE PLACE THIS SERVER SENDS SOMETHING THE PAGE DID NOT, and the
   * rule it bends was written for exactly this - "the bust stays as the thing
   * you SEE; what changes is the file sent behind it". It is allowed because
   * the preset is a GUIDE and not content: nobody's photograph is being
   * swapped, and `guide === "preset"` is the one provenance that says so.
   * A FAILED UPLOAD KEEPS THE BUST rather than failing the run - the old
   * behaviour is a worse picture, not a broken one. */
  if (values.guide === "preset" && spec.guideFile && values.source) {
    try { values.source = await sendLocal(spec.guideFile); }
    catch (err) { console.warn(`  .. guide swap skipped: ${err.message}`); }
  }

  const graph = await loadGraph(spec.graph);

  for (const [key, def] of Object.entries(spec.inputs)) {
    let v = values[key];
    if (v === undefined || v === "") continue;
    if (def.cast) v = def.cast(v);
    for (const addr of [def, ...(def.also || [])]) {
      const target = graph[addr.node];
      if (!target) return json(res, 500, { error: `node ${addr.node} is not in ${spec.graph}` });
      const at = addr.input ?? def.input;
      /* see the dry run's own note: an input holding an array is a socket,
       * and writing a literal into it is a 400 from Comfy that costs a
       * submission to discover. It is a wiring mistake, so it reads like
       * one. */
      if (Array.isArray(target.inputs?.[at])) {
        return json(res, 500, {
          error: `${addr.node}.${at} in ${spec.graph} is a link, not a widget - patch the node it comes from`,
        });
      }
      (target.inputs ||= {})[at] = v;
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
        if (!node) return `MISSING node ${ad.node}`;
        const at = ad.input ?? def.input;
        /* AND A SOCKET IS NOT A WIDGET. An input that already holds an array
         * is a LINK from another node, so writing a value there replaces the
         * wire with a constant - which Comfy refuses at submit, by name, for
         * money. Every address on this server is meant to be a widget: a
         * filename on a loader, a number on a sampler, a string on an
         * encoder. This is the one wiring mistake a dry run could not see
         * until it was looking for it. */
        if (Array.isArray(node.inputs?.[at])) {
          return `${ad.node}.${at} (${node.class_type}) IS A LINK - patch the node it comes from`;
        }
        return `${ad.node}.${at} (${node.class_type})`;
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
async function apiThumb(res, url, req) {
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
  if (!existsSync(dst)) return await serveStatic(res, "/" + want, req);
  res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "max-age=86400" });
  return res.end(readFileSync(dst));
}

/* A QUICK EDIT IS A TRIM, AND A TRIM IS ffmpeg - Babe, 2026-10-31: "can we
 * add the trim handles too. and make a save button in case you do want to
 * make a quick edit".
 * THE TAKE'S OWN CUT IS A RE-RECORD AND THAT IS RIGHT WHERE IT IS: a take
 * lives in the browser as a blob, there is no file to point a tool at, and
 * `cutTake` plays it into a second recorder in real time. A library clip is
 * the opposite - it is already a file on this disk - so re-recording it
 * would mean waiting out its own length to get a worse copy.
 * SO IT IS A STREAM COPY: no re-encode, no quality lost, and it returns
 * before the clip would have finished playing. `-ss` BEFORE `-i` seeks the
 * container rather than decoding up to the mark, which is what makes it
 * instant; with `-c copy` the cut lands on the nearest keyframe, which is
 * the honest trade for a quick edit and the reason this is not offered as a
 * frame-accurate one.
 * AND IT IS FILED WHERE A TAKE IS FILED, under the sitting's `takes/`, so a
 * quick edit turns up in the library beside everything else and can never be
 * mistaken for something a workflow made - `madeHere` reads the name shape
 * and this one says `trim`. */
async function apiTrim(req, res) {
  let body = {};
  try { body = JSON.parse((await readBody(req)).toString("utf8") || "{}"); } catch { }
  const want = String(body.path || "");
  if (!want.startsWith("output/") || want.includes("..")) {
    return json(res, 400, { error: "a trim is only ever of something in output/" });
  }
  const src = await findKept(want);
  if (!src || !existsSync(src)) return json(res, 404, { error: "no such clip" });
  const a = Math.max(0, Number(body.start) || 0);
  const b = Number(body.end);
  if (!isFinite(b) || b <= a + 0.05) return json(res, 400, { error: "that range is empty" });

  const ext = (want.match(/\.[a-z0-9]+$/i) || [".mp4"])[0].toLowerCase();
  const { day, time } = stamp();
  const session = (DEMO && (visitorSession(req) || mintVisitor(req, res))) || sessionDir(day);
  const dir = join(OUT, session, "takes");
  const name = `${time}-trim-${Date.now() % 100000}${ext}`;
  const dst = join(dir, name);
  try { await mkdir(dir, { recursive: true }); }
  catch (err) { return json(res, 500, { error: `could not write the trim: ${err.message}` }); }

  const args = `-v error -y -ss ${a.toFixed(3)} -to ${b.toFixed(3)} -i "${src}" -c copy "${dst}"`;
  await new Promise((go) => exec("ffmpeg " + args, () => go()));
  /* AND A CUT THAT PRODUCED NOTHING SAYS SO rather than handing back a path
   * to a file that is not there - the one failure a caller cannot see for
   * itself, because the request succeeded. */
  if (!existsSync(dst)) {
    return json(res, 500, { error: "ffmpeg could not cut that clip - is it installed?" });
  }
  const rel = `output/${session}/takes/${name}`;
  console.log(`  <- trimmed ${rel}`);
  return json(res, 200, { saved: rel, name });
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
const LOCAL_ONLY = new Set(["/api/health", "/api/key", "/api/session", "/api/output", "/api/take", "/api/trim", "/api/thumb"]);

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
  /* AND THE MIDDLE WORD SAYS WHAT IT IS - Babe, 2026-10-31, on the modal's
   * still-frame cell: "that can just be saved to assets". A frame pulled out
   * of a clip filed as `-webcam-` would be a name lying about where it came
   * from, which is this rail's oldest rule arriving in a filename. It is
   * still `takes/`, which is not a workflow folder, so `madeHere` refuses it
   * either way and a frame can never become a room. */
  const kind = String(url.searchParams.get("kind") || "webcam").replace(/[^a-z0-9]/gi, "").slice(0, 12) || "webcam";
  const name = `${time}-${kind}-${Date.now() % 100000}${ext}`;
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
  /* NEWEST FIRST MEANT NEWEST PATH, NOT NEWEST FILE - Babe, 2026-10-31,
   * looking at a clip made at 10:59 sitting second: "for some reason the
   * order is wrong in the session seems like it should be the first
   * thumbnail".
   * A PLAIN `sort().reverse()` IS A PATH SORT, so the FOLDER decides before
   * the time does: inside one sitting `takes/` beats `06/` beats `01/`, and
   * a webcam take from an hour earlier outranks the clip you just made. It
   * read as newest-first for as long as every file lived in a numbered
   * workflow folder and you worked up the rail in order; `takes/` and the
   * trims beside them are what made it visible.
   * SO THE KEY IS THE SITTING AND THEN THE CLOCK. The session has to stay
   * the OUTER key, because the panel draws its dividers by walking the list
   * and ending a group "where the name changes" - interleave two sittings
   * and that grouping comes apart. Inside one, the server's own name shape
   * carries `HHMMSS`, which is the time the file was written.
   * AND A FILE NOBODY HERE NAMED SORTS LAST IN ITS SITTING rather than
   * guessing: a hand-placed file has no stamp to read, and `000000` says
   * that honestly without a stat per file. */
  const stampOf = (f) => {
    const name = f.split("/").pop();
    const m = /^(\d{6})-/.exec(name);
    return m ? m[1] : "000000";
  };
  const sessionOf = (f) => (f.split("/")[1] || "");
  files.sort((a, b) => {
    const sa = sessionOf(a), sb = sessionOf(b);
    if (sa !== sb) return sa < sb ? 1 : -1;
    const ta = stampOf(a), tb = stampOf(b);
    if (ta !== tb) return ta < tb ? 1 : -1;
    return a < b ? 1 : -1;
  });
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

/* A FILE OF OURS, PUT WHERE COMFY CAN SEE IT, ONCE - Babe, 2026-10-29: "or on
 * the back-end for that model we just feed it something else like an outline of
 * a portrait", "like a guide".
 * IT IS CACHED BY PATH FOR THE LIFE OF THE PROCESS, because the bytes are a
 * file on disk rather than anything a person chose: the same guide uploaded
 * twice is the same content hash back, which is the proof the cache is right -
 * the template cache on 02 leans on exactly that. A failure to upload is
 * returned rather than thrown, so the caller can decide whether the run still
 * means something without it. */
const LOCAL_SENT = new Map();
async function sendLocal(rel) {
  if (LOCAL_SENT.has(rel)) return LOCAL_SENT.get(rel);
  const at = join(HERE, rel);
  const bytes = await readFile(at);
  const form = new FormData();
  form.append("image", new Blob([bytes], { type: "image/png" }), rel.split("/").pop());
  form.append("type", "input");
  form.append("overwrite", "true");
  const up = await fetch(`${BASE}/api/upload/image`, { method: "POST", headers: headers(), body: form });
  if (!up.ok) throw new Error(`guide upload failed (${up.status})`);
  const out = await up.json();
  const name = out.name || rel.split("/").pop();
  LOCAL_SENT.set(rel, name);
  console.log(`  -> sent ${rel} into input/ as ${name}`);
  return name;
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

/* A VIDEO THIS SERVER SENDS IS NOT SEEKABLE, AND NOTHING SAID SO - found
 * 2026-10-31, building the library's frame picker. Babe: "where you can
 * select a frame from the video". The scrub did nothing, the bar was fine,
 * the listener fired, and `video.seekable` came back EMPTY on a file whose
 * duration the browser already knew.
 * IT WAS THE SERVER. This handler answered every request with the whole file
 * and a 200 - no `Accept-Ranges`, no `Content-Length`, and a `Range` header
 * ignored outright - so Chrome treats the response as a stream it cannot
 * index and refuses to seek. `currentTime = 2` silently stayed 0.
 * AND IT HAD BEEN COSTING MORE THAN A SCRUB. `frameAt(url, t)` seeks before
 * it draws, so every frame pulled from a SERVED file was frame zero whatever
 * time was asked for - which is also why a frame-comparison test earlier the
 * same day reported one clip as identical at 0s, 2s and 4s. The plates got
 * away with it: `framesOf` is the caller that would have noticed, and what
 * it draws comes from blobs and data the browser already holds. */
async function serveStatic(res, pathname, req) {
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
    const head = {
      "Content-Type": MIME[extname(rel)] || "application/octet-stream",
      "Cache-Control": "no-store, must-revalidate",
      /* SAID ON EVERY FILE, not only the ones asked for in parts: it is how a
       * browser learns it MAY ask, and it is what turns `seekable` from an
       * empty list into the clip's own length. */
      "Accept-Ranges": "bytes",
      "Content-Length": bytes.length,
    };
    const asked = req && req.headers && req.headers.range;
    const m = asked && /^bytes=(\d*)-(\d*)$/.exec(String(asked).trim());
    if (m && (m[1] !== "" || m[2] !== "")) {
      /* `bytes=-500` is the LAST 500, which is how a player reads an mp4's
       * index when it sits at the end of the file. Getting that branch wrong
       * is getting seeking wrong on exactly the files that need it most. */
      let start = m[1] === "" ? bytes.length - Number(m[2]) : Number(m[1]);
      let end = m[1] === "" ? bytes.length - 1
                            : (m[2] === "" ? bytes.length - 1 : Number(m[2]));
      start = Math.max(0, start);
      end = Math.min(bytes.length - 1, end);
      if (!bytes.length || start > end) {
        res.writeHead(416, { "Content-Range": "bytes */" + bytes.length });
        return res.end();
      }
      head["Content-Range"] = "bytes " + start + "-" + end + "/" + bytes.length;
      head["Content-Length"] = end - start + 1;
      res.writeHead(206, head);
      return res.end(bytes.subarray(start, end + 1));
    }
    res.writeHead(200, head);
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
    if (url.pathname === "/api/thumb") return await apiThumb(res, url, req);
    if (url.pathname === "/api/session") return await apiSession(req, res, url);
    if (url.pathname === "/api/key" && req.method === "POST") return await apiKey(req, res);
    if (url.pathname === "/api/take" && req.method === "POST") return await apiTake(req, res, url);
    if (url.pathname === "/api/trim" && req.method === "POST") return await apiTrim(req, res);
    if (url.pathname === "/api/health") {
      /* which model names actually have a graph behind them, per rung, so the
       * menu can disable the rest instead of failing at the press. */
      /* what each model offers AND what it wants those cells set to, so the
       * row can follow the model instead of carrying the last one's numbers
       * into it — 25 steps on an 8-step distilled checkpoint is not a
       * setting, it is a bug. */
      /* WHAT A SPEC TAKES IS ITS INPUTS MINUS THE NODES IT DELETES. It was
       * `Object.keys(inputs)` outright, which is the table BEFORE `drop` has
       * had its say - so a mode that deletes a loader went on offering a
       * cell for what that loader was for. Babe, 2026-10-30, looking at 06:
       * "do the inputs change based on the mode you select". They did not:
       * every mode reported `(inherits)` because only a mode that RESTATES
       * `inputs` was reporting anything, and 06's three say it by dropping
       * nodes instead - SWAP drops 3, EDIT drops 2 and 3.
       * AND ON EDIT THAT WAS AN INVITATION TO A PAID REFUSAL: the node
       * validates `task_type: edit` AT SUBMIT and refuses a job with an
       * image beside it, which is `failed to validate images`. The quad was
       * offering two pictures that could only fail.
       * `dropWhenEmpty` IS NOT COUNTED. That one deletes a node when nobody
       * filled it, which is the input still being taken - it is the slot
       * being empty, not the model being unable. */
      const takesOf = (ins, drop) => {
        const dead = new Set((drop || []).map(String));
        return Object.keys(ins || {})
          .filter((key) => !dead.has(String((ins[key] || {}).node)));
      };
      /* AND WHAT A ROW MAKES, read off the graph it would run rather than
       * written down beside it - Babe, 2026-10-31: "maybe in the model
       * dropdowns we add T2V or T2I - when slots are not used".
       * THE SAVE NODE IS THE ANSWER AND IT IS ALREADY THERE. Every graph on
       * this rail ends in `SaveVideo`/`CreateVideo` or in `SaveImage`, so
       * a table saying which rungs make clips would be a second copy of a
       * fact the graph states outright - and the one that drifts is always
       * the copy. The cache is lazy, so the first health call reads them and
       * every one after it is free; `loadGraph` is how a run gets its graph
       * anyway. */
      const makesOf = async (name) => {
        try {
          const g = await loadGraph(name);
          const cls = Object.values(g).map((n) => n.class_type || "");
          if (cls.some((c) => /Video/.test(c))) return "video";
          if (cls.some((c) => /SaveImage/.test(c))) return "image";
        } catch { /* a row with no graph is already unpickable */ }
        return null;
      };
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
          /* AND WHAT A MODE CHANGES ABOUT ANY OF THAT, which is half the
           * answer and was invisible. `apiRun` resolves the variant and then
           * lays the pressed mode over it, so a mode may hand a row a
           * different input table, a different option list or different
           * defaults - and the page only ever heard the row's half. So the
           * two cells this mechanism exists for were both wrong on 05: STEPS
           * read 4 where 8 would run, and the SHEET face was offered on two
           * tabs whose graphs have no address for a sheet - a cell offering
           * to show you a picture that was not going to be sent.
           * IT IS THE FOUR FACTS THE PAGE ACTS ON AND ONLY WHERE THE MODE
           * NAMES THEM, so the client can lay them over the row with the
           * same shallow merge the server does rather than keeping a second
           * opinion about what a mode means. `only` is not among them: that
           * one pins a mode and is a fact about the row. */
          const modes = {};
          for (const [id, m] of Object.entries(spec.modes || {})) {
            const seen = {};
            if (m.params) seen.params = m.params;
            if (m.options) seen.options = m.options;
            if (m.defaults) seen.defaults = m.defaults;
            /* A MODE OVERRIDES WHAT IT NAMES AND INHERITS THE REST, which
             * is the same shallow merge `apiRun` does - so a mode that drops
             * a node without restating `inputs` is read against the row's
             * own table, and one that restates them is read against its. */
            if (m.inputs || m.drop) {
              seen.takes = takesOf(m.inputs || spec.inputs, m.drop || spec.drop);
            }
            /* AND AN EXPLICIT FALSE IS AN ANSWER. FLUX 3 Max opens on its one
             * picture and its SEQUENCE mode does not - six keyframes are the
             * shots - so the mode has to be able to say NO where the row says
             * yes. Testing the value rather than the key reported nothing, the
             * row's own true stood, and the picker hid FLUX from the one tab it
             * had been added for - caught by looking at the payload rather than
             * at the code. */
            if ("firstFrame" in m) seen.first = !!m.firstFrame;
            if (m.required) seen.required = m.required;
            if (m.names) seen.names = m.names;
            if (Object.keys(seen).length) modes[id] = seen;
          }
          if (name) wired[k][name] = { params: spec.params || null,
                                       options: spec.options || null,
                                       only: spec.only || null,
                                       takes: takesOf(spec.inputs, spec.drop),
                                       /* AND WHAT IT INSISTS ON BEING GIVEN,
                                        * which is `takes` from the other end
                                        * and the one fact the page was never
                                        * told - Babe, 2026-10-31: "what
                                        * happens if you dont use inputs. the
                                        * models that display are t2i or
                                        * t2v".
                                        * IT IS ALREADY DECLARED. Every row on
                                        * this server says what it cannot run
                                        * without, and the refusal has always
                                        * been honest; what was missing is
                                        * that the PICKER could not see it, so
                                        * a rung with an empty panel offered
                                        * every row and five of them could
                                        * only refuse. `takes` says what a
                                        * row CAN be handed; this says what it
                                        * MUST be - so the rows left standing
                                        * on an empty panel are exactly the
                                        * text-to-image ones. */
                                       required: spec.required || [],
                                       /* "image" or "video", so the picker can
                                        * say T2I or T2V on a row that is about
                                        * to run with nothing in the panel. */
                                       makes: await makesOf(spec.graph),
                                       defaults: spec.defaults || {},
                                       /* AND WHETHER THE PICTURE IT IS HANDED
                                        * BECOMES FRAME ONE, which decides
                                        * whether a tab that hands over a GRID
                                        * can use this row at all. */
                                       first: !!spec.firstFrame,
                                       /* and whether it reads a box table -
                                        * see the row that does */
                                       boxes: !!spec.boxes,
                                       /* AND WHAT THIS ROW CALLS THE SLOTS -
                                        * Babe, 2026-10-31: "when you select
                                        * the model it should change how the
                                        * slots, modes and agent works". The
                                        * row already decided WHICH cells
                                        * (`takes`) and which tabs (`only`);
                                        * this is the third thing it has to be
                                        * able to say, because LTX 2.3's first
                                        * reference is a FRAME and the cell
                                        * beside it on every other row is a
                                        * character. A mode can still override
                                        * it, which is the merge every other
                                        * field here follows. */
                                       names: spec.names || null,
                                       /* AND WHAT KIND OF FILE THAT CELL
                                        * TAKES - Babe, 2026-11-01, looking
                                        * at Kling's dark fourth quadrant:
                                        * "can we turn the 4th slot into
                                        * something so its not just blank,
                                        * make it usable", then "we can
                                        * update the slots based on the
                                        * model", then "that is part of our
                                        * pattern making, the slots are based
                                        * on the mode or model".
                                        * `names` was the third thing a row
                                        * could say about a cell and this is
                                        * the fourth: the slot's own
                                        * `faceAccept` is the floor, and a
                                        * row whose fourth input is a PICTURE
                                        * where the slot's is a SOUND has to
                                        * be able to say so, or the chooser
                                        * offers a file the job cannot
                                        * read. */
                                       accept: spec.accept || null,
                                       modes: Object.keys(modes).length ? modes : null };
        }
      }
      return json(res, 200, { ok: true, key: keyNow() ? "set" : "MISSING", wired });
    }
    return await serveStatic(res, url.pathname, req);
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
