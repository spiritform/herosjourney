/* Hero's Journey — wiring.
 *
 * The design lives in mockup.html and exposes exactly one seam, window.HJ.
 * Everything here binds to the page's own elements; nothing re-renders it.
 *
 *   LEFT SLOT IS INHERITED, RIGHT SLOT IS CHOSEN — and the inherited one is
 *   filled by carrying the rung before it across, which the server does in
 *   Comfy's own storage rather than through the browser.
 */
(function () {
  if (!window.HJ) return;

  /* Which graph input each slot feeds, per rung. The right slot of rung 3 is
     words rather than a file, so it has no key here. */
  var SLOTS = {
    1: { left: 'source', right: 'ref',  accept: { left: 'image/*', right: 'image/*' } },
    2: { left: 'figure', right: null,   accept: { left: 'image/*' } },
    3: { left: 'sheet',  right: 'place', accept: { left: 'image/*', right: 'image/*' } },
    /* 04 PLANS AND 05 SHOOTS, 2026-10-25. The board rung's left slot is the
       hero frame it draws FROM, which the server takes as `figure`; the key
       stays `start` because that is what the journey already wrote down and
       the run maps it. */
    /* AND ITS SECOND FACE IS THE SHEET, WHICH NOW TRAVELS. The box has shown
       FRAME and SHEET all along and only the frame was ever sent, so the
       close-ups on a board had nothing but one wide frame to read a face off
       and invented the rest. `alt` is that face's own key, the way it is on
       06, so an imported sheet is remembered apart from the frame. */
    4: { left: 'start',  right: null,   alt: 'sheet',
         accept: { left: 'image/*' } },
    /* and the motion rung's left slot is the board itself, with 02's sheet on
       its back - the same two references the clip has always taken. */
    /* AND THE SHEET ON ITS BACK HAS ITS OWN KEY, the way 04's does. Both
       travel - board on image_1, sheet on image_2 - so an imported sheet has
       to be remembered apart from the slate or switching faces would hand the
       model the other one. */
    5: { left: 'board',  right: null,   alt: 'sheet',
         accept: { left: 'image/*' } },
    /* 05's LEFT SLOT HAS TWO FACES AND ONE OF THEM IS SENT. `alt` is the
       second face's own key, so an imported LOCATION is remembered apart from
       an imported CHARACTER and switching between them cannot hand the model
       the other one. Both land on node 30 at run time - the graph has one
       reference_image - which is why they are a choice and not a pair. */
    6: { left: 'ref1',   right: 'clip', alt: 'place',
         accept: { left: 'image/*', right: 'video/*' } }
  };

  /* ADDRESSED BY SLOT, NEVER BY POSITION IN THE SLIDE. Every one of these used
     to read `slide.querySelectorAll('.drop')[n]` and call index 1 the right
     slot - which held while a slide had at most one box per slot, and stopped
     the moment 05's hero gained a LOCATION face: the second face sits between
     the two slots in the DOM, so the clip slot would have been wired to it. */
  function boxesOf(slide) {
    var inps = slide.querySelectorAll('.inp');
    var front = [], alt = [];
    for (var n = 0; n < inps.length; n++) {
      front.push(inps[n].querySelector('.drop:not(.alt)'));
      alt.push(inps[n].querySelector('.drop.alt'));
    }
    return { front: front, alt: alt };
  }

  /* A FIRST GUESS, SO NO BUTTON FLASHES "NOT WIRED" ON EVERY LOAD. The slots
     are bound before /api/health answers, and the Run buttons are built from
     this; `markWired()` replaces the whole thing a moment later and the server
     is the truth. Removing it once looked like dead code and broke every
     binding - `var` hoists the name, so the loop read `undefined[rung]` and
     threw before a single slot was wired. */
  var WIRED = { 1: true, 2: true, 3: true, 4: true, 5: true };

  var state = {};   // per rung: { source: 'name.png', ... , out: {filename, subfolder, type, url} }

  /* ------------------------------------------------------ the work so far */

  /* A JOURNEY SURVIVES A RELOAD. Five rungs is more than one sitting, and an
     empty rail after a refresh throws away real money - every slot here is a
     file somebody paid a GPU to make. Babe, 2026-10-24: "we need like a wip
     state. so i can go from 1 to 2 to 3 and back".

     WHAT IS SAVED IS NAMES AND URLS, NOT PICTURES. The files live in Comfy's
     input folder and in output/ on disk; this is the index that says which
     ones belong to which slot. localStorage can throw or come back empty - a
     private window, cleared site data - so every touch is guarded and the app
     opens on an empty rail rather than not at all.

     IT IS A CONVENIENCE, NOT A RECORD. `HJ.forget()` wipes it, which is the
     thing to reach for when a run starts failing on a file Comfy has since
     evicted from its input folder. */
  /* ONE JOURNEY PER SITTING, AND THE OLD ONE IS STILL THERE - Babe,
     2026-10-26: "can we create a new session state so i can go through each
     one with a new character. so remove the other character. i want to keep
     that other session state as well tho. so idk how we can do that",
     and the reason: "i need to start recording videos".
     SO THE KEY CARRIES THE SESSION. `hj-journey-session02` is a different
     drawer from `hj-journey-session01`; starting a session writes nothing to
     the old one and going back to it finds it exactly as it was. The server
     owns which session is current, because `output/` has to agree.
     THE OLD KEY IS ADOPTED, NOT ORPHANED. Everything made before today lives
     under `hj-journey-1`, so the first session to look for its own drawer and
     find it empty takes that one over - once, and only when it would
     otherwise open on an empty rail. */
  var LEGACY_KEY = 'hj-journey-1';
  var OUTPUTS = null;
  var SESSION = '';
  var SAVE_KEY = LEGACY_KEY;

  function setSession(name) {
    SESSION = name || '';
    SAVE_KEY = SESSION ? 'hj-journey-' + SESSION : LEGACY_KEY;
    OUTPUTS = null;
  }

  /* a file belongs to this sitting if its path says so - the listing is paths
     and the session is a folder in them. */
  function inSession(path) {
    return !SESSION || String(path).indexOf('/' + SESSION + '/') > -1;
  }

  /* A FILE IN A RUNG'S FOLDER IS NOT NECESSARILY A FILE THAT RUNG MADE, AND
     "NEWEST FIRST" IS ONLY TRUE OF THE ONES IT DID. Babe, 2026-10-27, with 04
     and 05 standing in the same room: "3 4 and 5 all look the same", "04
     should be the split screen image (custom one i ran)". 04's folder held
     three real runs and three files put there by hand - an import and two
     browser downloads - and `/api/output` sorts by path, so
     `heros-journey-05-….mp4` sorted above every timestamped name and will
     until the end of time. 04 was dressed with a frame of 05's clip.
     THE SERVER'S OWN NAME IS THE TEST: HHMMSS-model-seed.ext, which is the
     whole reason files are named that way - "enough to tell two rerolls apart
     and to reproduce either". Anything else in the folder is something
     somebody put there, and a rung cannot stand in a room it did not make.
     The review panel still shows everything: that is a view of the disk, and
     this is a question about what a workflow produced. */
  var MADE_HERE = /(^|\/)\d{6}-[^/]+-\d+\.[a-z0-9]+$/i;
  function madeHere(path) { return MADE_HERE.test(String(path || '')); }

  /* WHAT MADE IT, READ OFF THE NAME IT WAS SAVED UNDER - Babe, 2026-10-29:
     "i wonder if we should say what model it was made with in the meta data
     below on the left".
     THE FILENAME IS THE RECORD AND THE PICKER IS NOT. The row says which
     model would run NEXT, so a panel reading it would relabel a finished
     picture the moment somebody changed the dropdown behind it - a box
     lying about what it is holding, in the one cell whose whole job is to
     report what actually came back rather than what was asked for. The
     server writes `HHMMSS-model-seed.ext` precisely so a file can be traced
     an hour later, which is the third thing today to lean on that shape.
     AND THE SLUG IS TURNED BACK INTO THE ROW'S OWN NAME, not uppercased -
     `nano-banana-2-1` would print as NANO-BANANA-2-1 against a row that
     says NANO-BANANA-2.1, which is close enough to read as a typo. The
     wired names for that rung are the list to match against, so what shows
     is a name the picker also uses or nothing at all. */
  function madeWith(path, rung) {
    var m = /(^|\/)\d{6}-(.+)-\d+\.[a-z0-9]+$/i.exec(String(path || ''));
    if (!m) return '';
    var want = m[2].toLowerCase();
    var rows = Object.keys((WIRED && WIRED[rung]) || {});
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].toLowerCase().replace(/[^a-z0-9]+/g, '-') === want) return rows[i];
    }
    return '';
  }

  /* the URL that will still work tomorrow. A result is proxied out of Comfy
     at /api/file, which only holds while Comfy holds it; the server already
     keeps every finished file under output/, and that copy is ours. */
  function lastingUrl(file) {
    if (!file) return '';
    return file.saved ? '/' + file.saved : (file.url || '');
  }

  /* what a slot is showing, remembered beside what it is holding */
  function noteSlot(rung, key, url, isVid) {
    var s = st(rung);
    (s.urls = s.urls || {})[key] = { url: url, video: !!isVid };
    /* and it is no longer a slot somebody emptied */
    if (s.gone) delete s.gone[key];
    saveJourney();
  }

  /* AN EMPTY SLOT AND AN EMPTIED SLOT ARE NOT THE SAME SLOT - Babe,
     2026-10-26: "if i generate a random and then remove it... and refresh,
     lets make sure it stays removed". `fill()` dresses what it finds empty,
     and after the X there was nothing to tell it that the emptiness was a
     decision - so the roll it had just thrown away was the newest roll on
     disk and came straight back.
     IT IS REMEMBERED PER SLOT AND IT TRAVELS WITH THE JOURNEY, because the
     refresh is the whole point. Anything that puts something in the box
     clears it, which is `noteSlot` - the one place a slot records what it is
     showing. */
  function emptied(rung, key) {
    return !!(st(rung).gone && st(rung).gone[key]);
  }

  function saveJourney() {
    try {
      var out = { v: 1, rungs: {}, traits: {}, sheet: null };
      Object.keys(state).forEach(function (r) {
        var s = state[r], map = SLOTS[r] || {}, keep = {};
        [map.left, map.right, map.alt].forEach(function (k) { if (k && s[k]) keep[k] = s[k]; });
        if (s.urls) keep.urls = s.urls;
        /* and which cell put it there, where the cell is one that can say so */
        if (s.src && Object.keys(s.src).length) keep.src = s.src;
        if (s.gone && Object.keys(s.gone).length) keep.gone = s.gone;
        if (s.out) keep.out = s.out;
        /* WHAT THIS RUNG IS STANDING IN, which is not the same question as
           what it made. A result is a proposal until Continue journey accepts
           it, so a rejected one is on disk and in the review panel and is not
           a room - and deriving the plate from `out` on the way back in was
           the one place that still disagreed. */
        if (s.room) keep.room = s.room;
        /* AND WHICH ROW YOU PICKED - Babe, 2026-10-27: "we should prob make
           it so when you select a model / close and come back that model is
           still selected. so it doesnt reset to nano and you forget". The
           pressed row lived in the DOM and nowhere else, so every reload
           opened the whole rail on its partner default - and the cost of
           not noticing is a job you thought was free. It is a name, which is
           what this drawer is allowed to hold. */
        if (s.model) keep.model = s.model;
        /* AND WHAT KIND OF SHOT IT WAS - Babe, 2026-10-29, on an H3 clip that
           came back as the BOARD, animated, all six panels moving: "it created
           a video but it animated the board itself".
           THE CLAUSE THAT STOPS THAT EXISTS AND WAS NOT SENT. 05 asks 04 what
           it is shooting (`st(4).mode`) and the scaffolding only explains the
           contact sheet when the answer is `sequence` - the paragraph saying
           its panels are one moment, that the count is not a shot count, and
           that they are never to be rendered. `mode` was written by `runBoard`
           and kept nowhere, so a RELOAD between drawing the board and shooting
           it dropped the whole explanation and handed a video model a grid
           with nothing said about it. Babe had restarted the server in
           between, which is the one thing that always costs a reload.
           IT IS A FACT ABOUT WHAT THIS RUNG MADE, like `out` and `model`
           beside it, and it travels with them. */
        if (s.mode) keep.mode = s.mode;
        if (Object.keys(keep).length) out.rungs[r] = keep;
      });
      /* THE KEY ITSELF SAYS THE DRAWER KNOWS ABOUT ROOMS. A drawer written
         before this did, and its rungs have an `out` and no `room`, which is
         indistinguishable from a run somebody rejected - so an older drawer
         keeps the old derivation rather than opening on a bare rail. One
         save from now on and the question never comes up again. */
      out.rooms = 1;
      /* WHICH SECTION YOU WERE STANDING IN. It is one number beside the
         names and urls this drawer already holds, and it is written by the
         same save every other fact here goes through. */
      if (window.HJ && window.HJ.index) out.at = window.HJ.index();
      out.traits = traitsObj();
      var sh = document.querySelector('.tray .sheet[aria-pressed="true"]');
      if (sh) out.sheet = sh.dataset.sheet;
      localStorage.setItem(SAVE_KEY, JSON.stringify(out));
    } catch (err) { /* nothing here is worth failing a run over */ }
  }

  function restoreJourney() {
    var data;
    try { data = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); }
    catch (err) { return; }
    if (!data || data.v !== 1) return;

    Object.keys(data.rungs || {}).forEach(function (r) {
      var rung = +r, keep = data.rungs[r] || {}, map = SLOTS[rung] || {};
      var slide = window.HJ.slides[rung - 1];
      if (!slide) return;
      var boxes = boxesOf(slide);

      [map.left, map.right].forEach(function (k, n) {
        if (!k || !keep[k]) return;
        st(rung)[k] = keep[k];
        var u = keep.urls && keep.urls[k];
        if (u && u.url && boxes.front[n]) showMedia(boxes.front[n], u.url, u.video);
      });

      /* the second face of a two-faced slot, by its own key */
      if (map.alt && keep[map.alt]) {
        st(rung)[map.alt] = keep[map.alt];
        var ua = keep.urls && keep.urls[map.alt];
        if (ua && ua.url && boxes.alt[0]) showMedia(boxes.alt[0], ua.url, ua.video);
      }
      if (keep.model) st(rung).model = keep.model;
      if (keep.mode) st(rung).mode = keep.mode;
      if (keep.urls) st(rung).urls = keep.urls;
      if (keep.gone) st(rung).gone = keep.gone;
      /* A CELL THAT SAYS WHAT IS IN THE BOX HAS TO GO ON SAYING IT TOMORROW.
         The slot comes back from the journey holding Comfy's content hash,
         which cannot be traced to the file PRESET loaded, so the journey
         remembers the cell instead. */
      if (keep.src) {
        st(rung).src = keep.src;
        [[map.left, boxes.front[0]], [map.right, boxes.front[1]],
         [map.alt, boxes.alt[0]]].forEach(function (pair) {
          /* ONLY A CELL THAT NAMES A PARTICULAR FILE CAN BE PRESSED, and
             PRESET is the only one - IMPORT and WEBCAM hand over whatever you
             give them, so a pressed state on either says nothing. They are
             still recorded, because the run reads where a picture came from
             to choose its scaffolding; being recorded and being pressed are
             two different questions about the same fact. */
          /* AND A PROVENANCE WITH NO FILE BEHIND IT IS NOT A PROVENANCE -
             Babe, 2026-10-27, after a revert and a new session: "preset is
             white". A change that recorded `src.source = 'preset'` for the
             bust `fill` paints was reverted the same hour, but what it had
             already written stayed in the drawer, and this is what reads it:
             the cell came up pressed on every later load with nothing
             uploaded behind it. `HJ.forget()` would have cleared it, which is
             a thing to have to know.
             SO THE TWO FACTS HAVE TO AGREE. A real PRESET press uploads the
             file and writes its Comfy name, so a record with no name under it
             cannot have come from one - it is dropped rather than drawn, and
             any drawer the reverted change touched heals itself on the next
             load. */
          if (pair[0] && pair[1] && keep.src[pair[0]] === 'preset') {
            if (keep[pair[0]]) markAct(pair[1], 'preset');
            else delete keep.src[pair[0]];
          }
        });
      }

      /* the plate is this rung's own output or nothing, the same rule a live
         run follows - a restored rail must not be dressed better than the one
         you were standing in when you left. */
      /* A RUNG CANNOT HAVE MADE A FILE THAT IS FILED UNDER ANOTHER RUNG.
         `S` used to fall back to the newest file anywhere, so pressing it on
         a rung that had made nothing wrote someone else's output into the
         journey as that rung's own - and 05 then stood in 04's clip, wearing
         a room and six frames it never earned. The fallback is gone; this
         throws out what it already wrote. `saved` is the server's own path
         and it carries the rung that made it, so the check is the filing. */
      /* AND THE SAME CHECK ASKS WHETHER THIS SERVER WROTE IT AT ALL, because
         a journey already holds what the old reader wrote: 04's room was a
         frame of a clip somebody had downloaded into its folder, and a reload
         put it straight back. Only a path under output/ is judged - a result
         that has not been written down yet is still /api/file with a content
         hash on it, and that is not a filing claim. */
      var fromWhere = keep.out && (keep.out.saved || keep.out.url || '');
      if (fromWhere && fromWhere.indexOf('/output/') > -1 &&
          (fromWhere.indexOf('/0' + rung + '/') === -1 || !madeHere(fromWhere))) {
        delete keep.out;
        delete keep.room;
      }
      if (keep.room && String(keep.room).indexOf('/output/') > -1 &&
          (String(keep.room).indexOf('/0' + rung + '/') === -1 || !madeHere(keep.room))) {
        delete keep.room;
      }
      if (keep.out) st(rung).out = keep.out;
      /* AND THE ROOM COMES BACK ONLY IF IT WAS EVER PUT UP. Babe, 2026-10-26,
         on dismissing a result: "it just closes the modal and the background
         does not change, its like a cancel" - which was true until you
         reloaded, because the plate was derived from `out` and `out` is
         written the moment a job lands, accepted or not. */
      var room = data.rooms ? keep.room : (keep.out && lastingUrl(keep.out));
      if (room) {
        st(rung).room = room;
        if (isVideoName(room)) plateFromClip(room, rung, !wearsRoom(rung));
        else if (wearsRoom(rung) && window.HJ.setVoid) window.HJ.setVoid(room, rung - 1);
      }
    });
    paintSheetFace();

    (window.HJ.traits || []).forEach(function (t) {
      var v = (data.traits || {})[t.k];
      var el = v && document.querySelector('.tf[data-t="' + t.k + '"]');
      if (el) el.textContent = v;
    });

    if (data.sheet) {
      var btn = document.querySelector('.tray .sheet[data-sheet="' + data.sheet + '"]');
      if (btn && btn.getAttribute('aria-pressed') !== 'true') btn.click();
    }

    /* AND IT OPENS WHERE YOU LEFT OFF. Last, because the slots and the
       plates are put back first and this only decides which of them you are
       looking at - and a jump rather than a travel, so the intro cascade
       reveals the section you are actually on instead of three you walked
       past on the way. */
    if (typeof data.at === 'number' && window.HJ.jump) window.HJ.jump(data.at);
  }

  /* THE RAIL TELLS THE DRAWER WHERE IT IS. Every way of moving - the keys,
     the arrows, the nav, Continue journey - goes through the page's own
     `go`, and that calls this. It is the only thing here that writes on a
     travel, so it is also the only one that has to be cheap: `saveJourney`
     is a serialise and a localStorage write of a few hundred bytes. */
  window.HJ.onMove = function () { saveJourney(); };

  window.HJ.forget = function () {
    try { localStorage.removeItem(SAVE_KEY); } catch (err) {}
    return 'forgotten - reload for an empty rail';
  };

  function rungOf(slide) { return (+slide.dataset.n) + 1; }
  function st(r) { return (state[r] = state[r] || {}); }

  /* ------------------------------------------------------------- uploading */

  /* Until an agent writes these, a character is three rolls of a die. Kept
     deliberately plain: a silhouette, a wardrobe, a light. */
  /* WHO IT IS AND WHAT THEY DO ARE TWO PICKS NOW - Babe, 2026-10-26: "we
     should make some females too right? animals or something", "can we just
     add more variety", "diversity", "random can prob be in the prompt".
     A ROLE ON ITS OWN IS NOT NEUTRAL TO AN IMAGE MODEL. "a falconer" with
     nothing in front of it comes back as a white man in his thirties nearly
     every time, because that is the model's mean and a word list that does
     not say otherwise is a word list agreeing with it. The randomness has to
     be IN the sentence, which is Babe's own reading of why loosening the
     prompt would not have worked: a sampler has no memory between runs, so
     nothing but the words can carry variety.
     SO THE SUBJECT IS SAID AND THE ROLE IS SEPARATE, and the two multiply -
     16 x 20 people against the 12 the roll had, before the wardrobe and the
     light. The roles lost their article because the cast carries it.
     AND ONE IN SIX IS NOT A PERSON AT ALL. The reference is a style donor
     and nothing else - framing, angle and pose come from YOUR photograph -
     so a gorilla in a tailored three-piece donates the coat and the light
     and leaves your face alone, which is the whole point of wrapping
     something strange onto your own silhouette.
     (*) EVERY WORD BELOW IS MINE AND BABE'S TO CUT. */
  var ROLL = {
    cast: ['a woman', 'a man', 'a young woman', 'a young man',
           'an older woman', 'an older man', 'a Black woman', 'a Black man',
           'an East Asian woman', 'an East Asian man', 'a South Asian woman',
           'a South Asian man', 'a Latina woman', 'a Latino man',
           'a Middle Eastern woman', 'an Indigenous man'],
    who: ['gunslinger', 'deep-sea diver', 'lucha libre wrestler', 'stage magician',
          'cosmonaut', 'bare-knuckle boxer', 'plague doctor', 'rally driver',
          'lounge singer', 'falconer', 'riot medic', 'travelling preacher',
          'beekeeper', 'fire-eater', 'oil-rig welder', 'glacier guide',
          'street mechanic', 'drag performer', 'puppeteer', 'snake charmer'],
    /* and the ones a cast word would only get in the way of */
    beast: ['a silverback gorilla', 'a barn owl', 'a greyhound standing like a person',
            'a Highland bull', 'an octopus', 'a desert fox'],
    wear: ['a long oiled coat', 'a patched pressure suit', 'a sequinned cape', 'a tailored three-piece',
           'layered canvas work gear', 'a fur-collared flight jacket', 'a beaded ceremonial robe',
           'a cracked leather apron', 'a high beaded collar', 'a scarred respirator mask',
           'an embroidered marching band jacket', 'a fishing oilskin',
           'a motocross chest plate', 'a silk kimono jacket',
           'a hazmat suit cut down to a vest', 'a mourning veil and black lace'],
    light: ['one hard key from the left', 'a low warm key and deep falloff',
            'hard top light and black shadow', 'a cold rim from behind',
            'two hard kicks and nothing in between', 'a single practical in frame',
            'green light from a screen off frame', 'flat frontal light, no shadow'],
    /* AND WHERE THEY ARE STANDING CAN ROAM - Babe, 2026-10-26, asked
       whether the plain ground should stay: "im fine with filling in the
       scene since its just a style ref". It is: 01 takes wardrobe, hair,
       props and light off this picture and the framing, angle and pose off
       YOUR photograph, so a room in the reference is a room 01 is already
       refusing - and a figure lit BY somewhere is a better light donor than
       one lit in a void. The plain ground is still the most common answer,
       because it is the most readable one. */
    ground: ['against plain dark ground', 'against plain dark ground',
             'against a plain seamless backdrop', 'in a rain-black alley at night',
             'in a sunlit field of dry grass', 'in a neon-lit arcade',
             'on a snowfield at dusk', 'in a hotel corridor at night',
             'in a desert at noon', 'in a workshop full of tools',
             'on a rooftop above a lit city', 'in a hold of stacked cargo'],
    /* THE FRAMING, AND NOTHING ABOUT THE MEDIUM. Every one of these said
       "studio photograph" until 2026-10-26, which made the medium a thing
       the roll could not vary - six crops of one look. */
    frame: ['A full-length portrait', 'A waist-up portrait', 'A tight headshot',
            'A three-quarter portrait', 'A low-angle full-length portrait',
            'A close profile portrait'],
    /* AND THE MEDIUM IS ITS OWN PICK - Babe, 2026-10-26: "are they all
       portraits or is it pretty random... it prob can just be random since
       its about style". It is: this slot is a STYLE donor, and a style that
       is always a sharp 35mm photograph is one style.
       A MEDIUM HAS TO BE NAMED IN ITS OWN WORDS, which is the lesson
       `AGENT_SYS` already carries - Babe, on an agent that described what a
       game render looks like instead of saying so: "should it say something
       like in the style of a 3d video game". An image model cannot work
       back from the adjectives to the thing, so each of these leads with
       what it IS. */
    look: ['Photographic: sharp, high contrast, 35mm film grain.',
           'Shot on 16mm, soft halation, muted colour.',
           'A Polaroid: washed flash, soft focus, faded corners.',
           'An oil painting, visible brushwork.',
           'Inked comic art, heavy blacks, flat colour.',
           'A 3D video game render, clean edges, studio lighting.',
           'Claymation, fingerprints left in the surface.',
           'A woodcut print, hard black lines, two colours.',
           'An airbrushed 1980s poster.',
           'A tintype, silver and scratched.',
           'Anime cel art, flat shading, heavy line.',
           'A charcoal drawing, smudged, on grey paper.']
  };

  /* ONE IN SIX IS NOT A PERSON, and it is a branch rather than a sixteenth
     cast word because "a woman silverback gorilla" is the sentence a single
     list would have written sooner or later. */
  function rollWho() {
    return Math.random() < 1 / 6 ? pick(ROLL.beast)
         : pick(ROLL.cast) + ' ' + pick(ROLL.who);
  }
  /* SOMEWHERE, NOT SOMEONE. 03 rolls from its own table: a place, what the
     weather or the hour is doing to it, and where the light comes from. No
     people in it at all - the character arrives from the sheet, and a figure
     already standing in the reference is one the model has to remove. */
  var ROLL_PLACE = {
    where: ['a rain-black service corridor', 'a flooded underpass', 'a rooftop above a lit city',
            'a sodium-lit car park', 'a shuttered market street', 'a cold concrete stairwell',
            'a diner at the end of a highway', 'a treeline at the edge of a field',
            'a cargo hold', 'a tiled municipal pool, drained', 'a scrapyard of stacked cars',
            'a chapel with the roof gone'],
    weather: ['rain on everything', 'low fog holding the light', 'dry heat and dust in the air',
              'steam off the grates', 'snow coming in sideways', 'the air completely still'],
    light: ['one failing strip light', 'sodium orange from off frame', 'cold daylight through a far opening',
            'a single bare bulb', 'the glow of a city below', 'headlights raking across it'],
    frame: ['A wide photograph of', 'A photograph from the far end of', 'A low photograph of',
            'A photograph looking down into', 'A tight photograph of one corner of']
  };

  function pick(a) { return a[Math.floor(Math.random() * a.length)]; }

  /* Random reads the same row the Run button reads, so AR and a locked seed
     mean the same thing on both. */
  function rollValues(slide, text) {
    var ar = param(slide, 'ar') || '1:1';
    var v = { prompt: (text && text.trim()) || rollPrompt(rungOf(slide)), ar: AR[ar] || AR['1:1'] };
    var seedEl = slide.querySelector('.param[data-p="seed"]');
    if (seedEl && seedEl.dataset.lock === '1') v.seed = +param(slide, 'seed');
    return v;
  }

  /* ResolutionSelector takes a labelled string and the labels are not
     guessable — "2:3 (Portrait)" is refused, "2:3 (Portrait Photo)" is not.
     The row shows the ratio; this is what goes on the wire. */
  var AR = {
    '1:1': '1:1 (Square)',
    '2:3': '2:3 (Portrait Photo)',
    '3:4': '3:4 (Portrait Standard)',
    '3:2': '3:2 (Photo)',
    '4:3': '4:3 (Standard)',
    '9:16': '9:16 (Portrait Widescreen)',
    '16:9': '16:9 (Widescreen)',
    '21:9': '21:9 (Ultrawide)'
  };
  /* RUNG 01 IS IDENTITY, NOT ANATOMY. A whole body is rung 02's job, and a
     full-length figure at 1:1 puts the face in about forty pixels, which is
     the one thing this rung has to get right. */
  /* THE REFERENCE IS ONLY A STYLE DONOR, so its framing does not matter: the
     output takes framing, angle and pose from the source, which is the whole
     point of wrapping something strange onto your own silhouette. Letting the
     framing vary makes the deck more interesting, not less useful. */
  function rollPrompt(rung) {
    /* THE PLACE SLOT ESTABLISHES AN ENVIRONMENT, IT DOES NOT COMPOSE THE SHOT.
       Babe, 2026-10-24: "place is just to establish an environment image. not
       comp it". So the roll asks for an empty room and says so twice - the
       character arrives from the sheet when Run puts them in it, and a figure
       already standing in the reference is one the model has to remove. */
    if (rung === 3) {
      return pick(ROLL_PLACE.frame) + ' ' + pick(ROLL_PLACE.where) + ', ' +
             pick(ROLL_PLACE.weather) + ', ' + pick(ROLL_PLACE.light) + '. ' +
             'Empty: nobody in the frame, no people anywhere. ' +
             'Photographic, 35mm film grain, no text anywhere in the frame.';
    }
    return pick(ROLL.frame) + ' of ' + rollWho() + ' ' + pick(ROLL.ground) + ', wearing ' +
           pick(ROLL.wear) + '. ' + pick(ROLL.light) + '. ' + pick(ROLL.look) + ' ' +
           'One character only, no text anywhere in the frame.';
  }

  /* THE SHEET TRAVELS WITHOUT BEING CARRIED. 04 keeps the character sheet on
     the other face of its slot, and nothing hands it across: 02 made it two
     rungs back and Continue journey only ever moves one rung forward. So that
     face is painted from 02's own output whenever 02 has one - on a finished
     run and on a restored journey alike. Babe, 2026-10-24: "can we get the
     sheet in there from 02". */
  /* 04 WEARS BOTH OF ITS REFERENCES WITHOUT BEING HANDED THEM. Continue
     journey carries one rung forward, which is right for walking the rail and
     useless for working on 04 on its own: the hero frame is 03's output and
     the sheet is 02's, and neither arrives if you load the page on 04.
     Babe, 2026-10-25: "04 should carry 03 as we dev this".
     SHOWING IS NOT THE SAME AS SENDING. These paint the boxes from whatever
     those rungs made; the files themselves are carried into Comfy at run
     time, where a failure can be reported instead of swallowed on load. */
  /* 05 WEARS THE SAME TWO, FOR A BLUNTER REASON. Its left slot said "from
     04", and 04 is the one rung that cannot fill it: 04 makes a clip and this
     slot takes a picture. So both rungs dress from 03 and 02 - Babe,
     2026-10-25: "we need to first add the character sheet, hero frame to
     (style ref) the HERO (character) slot on the left". The pair is
     {slide index, the key its left slot holds}; nothing else about the two
     differs, so they share the one function rather than a copy of it. */
  /* EACH FACE NAMES THE RUNG IT IS MADE OF, AND THE TWO SLIDES DISAGREE ABOUT
     WHICH WAY ROUND. 04 leads with the frame it is restaging and keeps the
     sheet behind it; 05 leads with the sheet, because the sheet is the
     character and the frame is one place they have been - Babe, 2026-10-25:
     "we show the character sheet", "location is like the hero frame we made
     in the garage or really any image you want to use". */
  var WEARS = [
    { at: 3, faces: [{ from: 3, key: 'start' }, { from: 2, key: 'sheet' }] },
    /* 05's front face is the board 04 drew and its back is 02's sheet - the
       two references the clip takes, in the box they are taken from. */
    { at: 4, faces: [{ from: 4, key: 'board' }, { from: 2, key: 'sheet' }] },
    /* and LOCATION names the newest place the character has stood, which is
       05's clip now rather than 04's - 04 draws a board, which is a plan and
       not a place. 03's frame is still behind it. */
    { at: 5, faces: [{ from: 2, key: 'ref1' }, { from: [5, 3], key: 'place' }] }
  ];

  /* WHAT THAT RUNG MADE, EVEN WHEN THIS SESSION DID NOT MAKE IT. The rail
     remembers a journey, and an empty one leaves 05 showing the words "Your
     sheet" over a rung that has made four of them - Babe, 2026-10-25: "can we
     get the sheet in there by default". `output/` is the real record, so a
     face with nothing in state falls back to the newest file in the folder of
     the rung it is made of, exactly the way `S` picks one. It is shown, so it
     is no secret which file it is, and showing is still not sending: the run
     uploads whatever the box ended up holding. */
  async function newestIn(rung) {
    if (!OUTPUTS) OUTPUTS = fetch('/api/output').then(function (r) { return r.json(); });
    var list = await OUTPUTS;
    var files = ((list && list.files) || []).filter(inSession);
    /* the listing sorts newest first and the rung is in the path, the same
       way `S` tells one rung's folder from another's. */
    for (var n = 0; n < files.length; n++) {
      if (files[n].indexOf('/0' + rung + '/') > -1 && madeHere(files[n]) &&
          !isVideoName(files[n])) return files[n];
    }
    return '';
  }

  function paintSheetFace() {
    WEARS.forEach(function (w) {
      var slide = window.HJ.slides[w.at];
      if (!slide) return;
      var rung = w.at + 1;
      var boxes = boxesOf(slide);

      w.faces.forEach(async function (f, n) {
        var box = n === 0 ? boxes.front[0] : boxes.alt[0];
        if (!box) return;
        /* a picture you put here yourself outranks the one the rail made,
           and so does having taken one out: the X is an answer too.
           BUT THE TEST IS WHAT THE BOX IS SHOWING, NOT WHAT THE STATE
           REMEMBERS. A name in state is what this face will SEND; a journey
           that has a name and no url leaves the box empty, and skipping on
           the name alone left it empty for good. An emptied face still wins,
           because that one is a decision. */
        if (f.key && emptied(rung, f.key)) return;
        if (f.key && st(rung)[f.key] &&
            box.querySelector(':scope > img, :scope > video')) return;

        /* A FACE MAY NAME MORE THAN ONE RUNG, NEWEST FIRST - Babe,
           2026-10-25: "for location i would also like to use the shot that
           was created in 04". The location is the last place the character
           has stood, which is 04 once 04 has made something and 03 before
           that, so the face takes the first of its rungs that has anything
           rather than being pinned to one. */
        var froms = [].concat(f.from);
        for (var c = 0; c < froms.length; c++) {
          var made = st(froms[c]).out;
          var plate = st(froms[c]).plate;
          /* THE FRAME COMES BEFORE `out`, AND 04 IS WHY. 04 is two
             generations on one rung and the LAST thing it writes to `out` is
             whichever finished last - which on this journey was the board,
             a layout drawing. The shot 04 actually made is the clip, and the
             only picture of a clip is the frame already pulled out of it to
             be 04's own room. A data URL says exactly that: an image plate is
             a path, and a frame has nowhere to be a path from. There is no
             file behind it either, so the box records which rung it came from
             and the run uploads the frame - showing is still not sending. */
          if (plate && /^data:/.test(plate)) {
            delete box.dataset.fromFile;
            box.dataset.frameOf = froms[c];
            return showMedia(box, await bigFrame(froms[c]), false);
          }
          if (made && !isVideoName(made.filename)) {
            delete box.dataset.frameOf;
            delete box.dataset.fromFile;
            return showMedia(box, lastingUrl(made), false);
          }
          if (plate) {
            delete box.dataset.fromFile;
            box.dataset.frameOf = froms[c];
            return showMedia(box, plate, false);
          }
        }
        /* nothing in this session: the folder is the memory */
        if (box.querySelector('img, video')) return;
        for (var k = 0; k < froms.length; k++) {
          var path = await newestIn(froms[k]);
          if (!path || box.querySelector('img, video')) return;
          box.dataset.fromFile = path;
          return showMedia(box, '/' + path, false);
        }
      });
    });
  }

  /* STILLS OUT OF A FINISHED CLIP, FOR THE DEPTH TO WEAR - Babe, 2026-10-25:
     "after you generate the video in 04, on the back-end it basically takes a
     still frame from it every second or something... maybe just 4 frames.
     then adds those into the z-space at various z-positions".
     IT COSTS NOTHING AND NEEDS NO MODEL: a <video> seeked to a time and drawn
     into a canvas, the same trick the sheet template already uses to
     rasterise itself. The frames stay in the page as data URLs - small ones,
     320px wide - so nothing is written anywhere and a reload simply has none.
     AND IT CLOSES A STRUCTURAL HOLE. Both plate paths do `isVideoName(...) ?
     '' : lastingUrl(file)`, so 04 and 05 - the two rungs that output clips -
     were incapable of dressing their own section however often they ran. A
     frame is a picture, so now they can. */
  /* `wide` is how big each frame comes out. 320 is a room - it is blurred
     into a texture and nobody reads it - and a reference image is not: the
     same frame has to go to the model at a size it can see. */
  function framesOf(url, count, every, wide) {
    return new Promise(function (done) {
      var v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.crossOrigin = 'anonymous';
      v.preload = 'auto';
      var out = [], want = [], at = 0;

      function give() { done(out); v.removeAttribute('src'); v.load(); }

      v.addEventListener('error', function () { done(out); });
      v.addEventListener('loadedmetadata', function () {
        var span = v.duration || 0;
        if (!span || !isFinite(span)) return give();
        /* a frame every `every` seconds, and never the very first or last -
           a clip's first frame is usually the hero frame it was built from,
           which is already the room. */
        for (var n = 0; n < count; n++) {
          var t = Math.min(span * 0.98, (n + 1) * every);
          if (t < span) want.push(t);
        }
        if (!want.length) want.push(span / 2);
        v.currentTime = want[0];
      });
      v.addEventListener('seeked', function () {
        var w = wide || 320;
        var h = Math.round(w * (v.videoHeight || 9) / (v.videoWidth || 16));
        var c = document.createElement('canvas');
        c.width = w; c.height = h;
        try {
          c.getContext('2d').drawImage(v, 0, 0, w, h);
          out.push(c.toDataURL('image/jpeg', w > 640 ? 0.92 : 0.72));
        } catch (err) { return give(); }
        at++;
        if (at >= want.length) return give();
        v.currentTime = want[at];
      });
      v.src = url;
    });
  }

  /* A ROOM IS NOT A PICTURE OF THE SHOT, AND THE SLOT WAS SHOWING THE ROOM -
     Babe, 2026-10-26, double-clicking 06's character for a bigger look and
     getting a 320x180 panel: "i noticed this image is tiny too". 320px is
     what a plate is for: it is blurred into a texture and nobody reads it.
     The slot beside it is a reference you are meant to look at, and the run
     already knew that - it pulled the same frame again at 1280 on its way to
     the model. So the box was showing one picture and sending another, which
     is the one thing this rail keeps having to re-learn: WHAT YOU ARE
     LOOKING AT IS WHAT GETS SENT.
     IT IS PULLED ONCE AND KEPT ON THE RUNG, so the painter, a second face
     and every run after it share one frame rather than seeking the clip each
     time. It is never saved: `saveJourney` keeps an allowlist of names and urls,
     and a 1280px data URL is a picture. */
  function bigFrame(rung) {
    var s = st(rung);
    if (s.frame) return Promise.resolve(s.frame);
    if (!s.shot) return Promise.resolve(s.plate || '');
    return framesOf(s.shot, 1, 1, 1280).then(function (f) {
      if (f.length) s.frame = f[0];
      return s.frame || s.plate || '';
    }).catch(function () { return s.plate || ''; });
  }

  /* A CLIP CANNOT BE A PLATE, SO ONE OF ITS FRAMES IS. That is the whole of
     what the extraction is for now: `--void-src` is a CSS background and a
     video in one draws nothing, which is why 04 and 05 could never be
     standing anywhere. */
  async function plateFromClip(url, rung, quiet) {
    if (!url || !window.HJ.setVoid) return 0;
    try {
      var frames = await framesOf(url, 1, 1);
      if (!frames.length) return 0;
      /* remembered as well as shown, because the sections after this one wear
         it in their collage and a data URL has nowhere else to come from. */
      st(rung).plate = frames[0];
      /* AND WHERE IT CAME FROM, because 320px is a room and not a reference:
         05's location wears this frame and sends it, and sending it means
         pulling it again at a size the model can read. */
      st(rung).shot = url;
      /* AND THE FRAME IS NOT ALWAYS A ROOM. Boot needs the extraction - 05's
         LOCATION face wears 04's shot and cannot ask for it until somebody
         has pulled one - and boot must not put a room up, which is the rule
         below. */
      if (!quiet) window.HJ.setVoid(frames[0], rung - 1);
      return 1;
    } catch (err) { return 0; }
  }

  /* THE DEPTH IS THE JOURNEY SO FAR, NOT FOUR STILLS OF ONE TAKE - Babe,
     2026-10-25: "the video frames all look the same basically", "so it wont
     look cool unless the video changes a lot", "maybe we should just do more
     of a collage, from each section, so a character face, location, small
     sheet, etc", "reusing all the backgrounds in one, but scaling them down".
     Four frames of a four-second shot are the same picture four times; four
     SECTIONS are four genuinely different pictures, and they are already the
     rooms you walked through. So each section wears the rooms behind it,
     scaled down and set at their own depths - nothing new is generated and
     nothing is invented, it is the rail looking back at itself. */
  /* A COLLAGE NEEDS SOMETHING TO BE A COLLAGE OF. Two rooms were showing one
     layer behind 02 and two behind 03 - Babe, 2026-10-25: "even on 2 they are
     showing" - and a single soft plate floating over another soft plate does
     not read as the journey piling up, it reads as the room being wrong. So
     it takes three. */
  var COLLAGE_MIN = 3;

  /* AND IT BELONGS TO THE ENDING, NOT TO EVERY SECTION WITH ENOUGH RAIL
     BEHIND IT. Babe, 2026-10-25, on finding it behind 04: "im seeing elements
     on 04 and it should only be the close-up image that was created from 04",
     "so the collage is appearing", "when you go to 05 they pop off". Having
     it on two sections in a row is what made it read as a glitch rather than
     as a layer: the same four pictures stand behind 04, then travel out and
     reassemble on 05, so arriving at the ending shows you what you were
     already looking at. 04 is still a step forward and it stands in the room
     it just made; 05 is the rung that loops, which is the one place where
     looking back at the whole rail is what the section is FOR. */
  var COLLAGE_AT = 6;

  function collageFor(rung) {
    if (rung !== COLLAGE_AT) return [];
    var out = [];
    for (var r = 1; r < rung; r++) {
      var made = st(r).out;
      var url = made && !isVideoName(made.filename) ? lastingUrl(made) : '';
      if (!url && st(r).plate) url = st(r).plate;
      if (url) out.push(url);
    }
    return out.length >= COLLAGE_MIN ? out : [];
  }

  /* THE SECTION THAT LOOKS BACK DOES NOT STAND IN A ROOM OF ITS OWN. Babe,
     2026-10-28, on the ending: "im getting a massive image behind 06 too idk
     where its from like a 5th image?". It is not a fifth shard - the collage
     is capped at four by `NEAR`'s own length - it is 06's OWN plate, because
     every path that dresses a section dressed all six, and this file has said
     since the collage was built that 06 wears the rail behind it and no room
     of its own. The code and the note disagreed and the note is the intent.
     AND IT IS ONE PREDICATE RATHER THAN A CONDITION IN `dressRung`, because
     there are FOUR things that put a plate up - a live run, a restore, `S`
     and `dress` - and a rule written at one of them is a rule three of them
     break. One mechanism per fact, a sixth time.
     THE FRAME IS STILL PULLED, just not hung: `plateFromClip` is handed
     `quiet` instead of being skipped, so `st(rung).plate` and `.shot` are
     there for whatever reads them next, which on a rung that LOOPS is the
     next thing it makes. */
  function wearsRoom(rung) { return rung !== COLLAGE_AT; }

  /* every section at once, because one new output changes what every section
     after it is standing in. */
  /* AND IT STOPPED ONE SHORT OF THE RUNG THAT WEARS IT - Babe, 2026-10-26:
     "06 should actually be showing the collage from previous workflows in the
     background i believe". It was. `COLLAGE_AT` moved to 6 with the split,
     and this loop did not: it ran 1..5 and so never once asked for the only
     section `collageFor` answers about. The collage was computed correctly
     and handed to nobody.
     THAT IS THE FIFTH THING THE RENUMBERING BROKE, and the fifth found by
     looking for it - after `fill`, `dress`, the four folder matchers and
     `rung < 5` on the result foot. It reads `slides.length` now, like the
     nav, the ticker, the jump keys and the two that were fixed before it.
     **Assume there is a sixth.** */
  function dressCollages() {
    if (!window.HJ.setShards) return;
    var last = (window.HJ.slides || []).length || 6;
    for (var rung = 1; rung <= last; rung++) {
      window.HJ.setShards(collageFor(rung), rung - 1);
    }
  }
  window.HJ.collage = dressCollages;

  /* bytes of any provenance, put where Comfy can load them - a file off our
     own disk, or a frame that only ever existed in the page. */
  async function uploadBlob(blob, name) {
    var up = await fetch('/api/upload?name=' + encodeURIComponent(name), {
      method: 'POST', headers: { 'Content-Type': blob.type || 'image/png' }, body: blob
    });
    var got = await up.json();
    if (!up.ok) throw new Error(got.error || 'upload failed');
    return got.name;
  }

  /* a file that only exists on our disk, put where Comfy can load it. The
     same two steps `S` takes, which is why they are one function now. */
  async function uploadLocal(path) {
    var blob = await (await fetch('/' + path)).blob();
    var up = await fetch('/api/upload?name=' + encodeURIComponent(path.split('/').pop()), {
      method: 'POST', headers: { 'Content-Type': blob.type || 'image/png' }, body: blob
    });
    var got = await up.json();
    if (!up.ok) throw new Error(got.error || 'upload failed');
    return got.name;
  }

  /* A WAITING MARK IS NOT CONTENT, AND SNAPSHOTTING ONE MAKES IT FOREVER -
     Babe, 2026-10-26: "can we revisit the random image for style. something
     is stuck", "i pressed random and then went to edit and now i just see
     the loading animation but nothing is happening". The roll had actually
     finished - the server kept the file and carried it - and what was on
     screen was an EMPTY slot with the three squares still going.
     `roll` appends the mark to the box and `showMedia` captures `hint` on its
     way past - the empty-slot markup, taken the first time anything fills
     that box, which on a fresh sitting is DURING the roll. So the hint was
     the empty slot PLUS the spinner, and the next thing to put it back -
     the corner X, a writing face closing on nothing - painted a permanent
     animation into an empty box.
     SO EVERY SNAPSHOT GOES THROUGH ONE READER, and it leaves out the two
     things in a box that are furniture rather than what it is holding: the
     waiting mark, and the file chooser every caller re-appends by hand. */
  function bareHTML(box) {
    var c = box.cloneNode(true);
    /* `.whybox` IS FURNITURE TOO - it is a note about the mode, not something
       the box is holding, and a snapshot that carried it would restore it as
       dead markup over whatever came back. Same reason the picker comes out. */
    c.querySelectorAll('.wait, .whybox, input[type=file]').forEach(function (n) { n.remove(); });
    return c.innerHTML;
  }

  function showMedia(box, src, isVideo) {
    /* CAPTURED ONCE, AND "ONCE" HAS TO MEAN EVER - the same empty-string
       trap as the restore below it. A slot with no words in its table has an
       empty hint, which is falsy, so `if (!hint)` captured it again on the
       next fill - with a picture in the box by then. The hint would have
       become the thing it exists to replace. */
    if (box.dataset.hint === undefined) box.dataset.hint = bareHTML(box);
    /* THE REMOVE BUTTON IS FURNITURE, NOT CONTENT. The board's X lives inside
       the box that holds the picture - so that it can only ever draw over
       one - and this clears that box to put the picture in it. */
    /* AND THE FILE CHOOSER IS FURNITURE BY THE SAME ARGUMENT, which this line
       has been throwing away since it was written. Measured in the page,
       2026-10-27: every box with something in it had lost its picker and
       every empty one still had it - so `wantsVideo`, which is `!!picker &&
       ...`, answered NO on a filled clip slot. The camera on 06 would then
       have opened with still-camera constraints and no microphone and taken a
       PNG where a take was wanted, and `bareHTML` strips the picker on the
       way out precisely BECAUSE every caller is supposed to put it back.
       The node is moved rather than re-made, so the change listener
       `bindSlot` bound to it comes with it. */
    var x = box.querySelector(':scope > .clr');
    var picker = box.querySelector('input[type=file]');
    box.innerHTML = '';
    if (x) box.appendChild(x);
    if (picker) box.appendChild(picker);
    var el = document.createElement(isVideo ? 'video' : 'img');
    el.src = src;
    if (isVideo) {
      /* `defaultMuted` IS THE ONE THAT SURVIVES A ROUND TRIP THROUGH MARKUP,
         and this page does that round trip on purpose - Babe, 2026-10-27:
         "its when i change the mode and then hit prompt". Every other media
         property reflects to an attribute, so a restored box came back with
         `autoplay` and `loop` and without the mute: the clip started itself,
         looped, and had its sound on, behind a writing box where you could
         hear it and not see it. `muted` is the exception in the HTML spec -
         the property does not reflect, `defaultMuted` is what writes the
         attribute - so the fix is one word rather than a re-mute at every
         place a box is put back together. */
      el.muted = true; el.defaultMuted = true;
      el.loop = true; el.playsInline = true; el.autoplay = true;
      /* the length of what you brought is the length of what comes back, so
         the row can say it the moment the file is readable. */
      el.addEventListener('loadedmetadata', function () { markDuration(box); });
    }
    box.appendChild(el);
    /* AND A CLIP IN A SLOT CAN BE HEARD, BY ASKING - Babe, 2026-10-27: "i cant
       hear the audio", "it does have audio because i double click on it to
       view i can hear it", "just not in the slot". Every clip in a box is
       muted on purpose, by the rule directly above: a slot clip loops, and a
       looping clip with sound on is the thing that plays behind a writing box
       where you can hear it and not see it. So the mute stays the default and
       the speaker is the way out of it - which is also what Chrome's autoplay
       policy wants, since a press is the gesture that buys unmuted playback.
       THE HANDLER IS DELEGATED AND THAT IS THE WHOLE TRICK. This box gets
       round-tripped through its own markup every time a face opens over it,
       and an element carrying a listener comes back dead - the trap the file
       picker is pulled out of the snapshot to avoid. A button nothing is bound
       to survives the trip, so the glyph is painted from the video's own
       `muted` and the restored copy works exactly like the original. */
    if (isVideo) {
      var spk = document.createElement('button');
      spk.className = 'spk';
      spk.type = 'button';
      spk.dataset.v = 'off';
      spk.setAttribute('aria-label', 'Sound');
      box.appendChild(spk);
    }
    box.classList.add('is-filled');
    if (box.parentNode) box.parentNode.classList.add('is-full');
  }

  /* ONE HANDLER FOR EVERY SPEAKER ON THE PAGE, now and after any restore. It
     reads the clip's own state rather than the glyph's, so a button that came
     back from a snapshot cannot disagree with the thing it controls. */
  document.addEventListener('click', function (e) {
    var spk = e.target.closest && e.target.closest('.spk');
    if (!spk) return;
    e.stopPropagation();
    e.preventDefault();
    var el = spk.parentNode && spk.parentNode.querySelector('video');
    if (!el) return;
    el.muted = !el.muted;
    /* the attribute, not just the property - see defaultMuted above, or the
       sound comes back on by itself the next time a face closes over it. */
    el.defaultMuted = el.muted;
    spk.dataset.v = el.muted ? 'off' : 'on';
    if (!el.muted) { var go = el.play(); if (go && go.catch) go.catch(function () {}); }
  }, true);

  /* HOW LONG WHAT COMES BACK WILL BE, SAID BY THE ROW - Babe, 2026-10-25:
     "we may need to expose a duration next to the model dropdown - auto",
     "what about showing duration next to seed". It is UNEDITABLE and not
     uninvolved, which this comment got wrong for a fortnight: it was written
     when the two rows here were the two that cannot take a length -
       - SEEDANCE-2.5-EDIT: `task_type: "edit"` keeps the source clip's own
         length and aspect ratio in the node's own words, and ignores the
         `duration` and `ratio` widgets entirely.
       - SCAIL-2: the graph is two 81-frame windows with a 5-frame overlap
         (213:183 a=1, 262:240 a=2, start = (81-5)x(a-1)), so it makes 157
         frames at the clip's own fps whatever you hand it. A third chunk is
         a duplicated stage, not an input.
     - and RESHOOT on Seedance, and H3, both DO. So the number this writes
     travels: `valuesFor` sends it as `model.duration` on every 06 mode but
     EXTEND. Babe, 2026-10-27, asking the question that caught it: "the
     duration is based on the web-cam video right?". Yes - a 6.9s take goes
     as 7. AUTO is what the cell says when there is no clip to read, and that
     sends nothing and leaves the rung's own default standing. */
  function markDuration(box) {
    var slide = box.closest && box.closest('.slide');
    var cell = slide && slide.querySelector('.param[data-p="duration"] b');
    if (!cell) return;
    var vid = slide.querySelector('.inp .drop video');
    var secs = vid && vid.duration;
    cell.textContent = secs && isFinite(secs) ? secs.toFixed(1) + 's' : 'AUTO';
  }

  /* the X: put the slot back the way it was found */
  /* WHICH CELL THE PICTURE IN THIS BOX CAME FROM - Babe, 2026-10-25: "can we
     have preset selected here". PRESET is the one cell in a tray that names a
     particular file, so it is the one that can be in a state: pressed means
     what you are looking at is that file. IMPORT and WEBCAM hand over
     whatever you give them, so a pressed state on either would say nothing.
     Anything else filling the box clears it, because the cell would otherwise
     go on claiming a picture it did not put there. */
  function markAct(box, act) {
    var tray = box.parentNode && box.parentNode.querySelector('.tray');
    if (!tray) return;
    tray.querySelectorAll('[data-act]').forEach(function (c) {
      c.setAttribute('aria-pressed', act && c.dataset.act === act ? 'true' : 'false');
    });
  }

  /* A REPLACEMENT IS NOT A REMOVAL, which is the whole of what `replacing`
     says. `gone` is the slot remembering that being empty was a DECISION -
     without it `fill()` dresses the box again on the next load and the roll
     you threw away comes straight back. Rolling again is not that decision:
     you are asking for a different picture, and the one that arrives is what
     the slot should remember. */
  function clearSlot(box, rung, key, replacing) {
    markAct(box, null);
    setTimeout(function () { markDuration(box); }, 0);
    if (!replacing) (st(rung).gone = st(rung).gone || {})[key] = 1;
    if (st(rung).src) delete st(rung).src[key];
    /* AND THE X PUTS THE CAMERA DOWN PROPERLY. It stopped the tracks inline
       and left the row standing in a face with no stream behind it - the X
       draws over a live preview, because a previewing box is `is-filled`. */
    stopCam(box);
    box._camWas = null;
    delete st(rung)[key];
    if (st(rung).urls) delete st(rung).urls[key];
    saveJourney();
    var picker = box.querySelector('input[type=file]');
    /* AN EMPTY HINT IS STILL A HINT, AND THE TEST WAS TRUTHINESS - Babe,
       2026-10-26, pressing RANDOM over a picture: "still see the loader over
       the image". A slot whose table gives it no words (01's STYLE, 06's
       clip) has an empty box: its markup is the file chooser and nothing
       else, and `bareHTML` strips the chooser - so `hint` is the empty
       string, which is exactly what this box should go back to and exactly
       what `if (hint)` refuses to put back. The picture stayed, under a
       spinner, with the state already deleted from under it.
       IT READ TRUE BY ACCIDENT UNTIL TODAY: the raw innerHTML carried the
       chooser's tag, so the string was never empty. The corner X went the
       same way the moment the snapshot got honest. `!== undefined` is the
       question that was always meant - has this box ever been captured. */
    if (box.dataset.hint !== undefined) box.innerHTML = box.dataset.hint;
    box.classList.remove('is-filled', 'is-busy');
    if (box.parentNode) box.parentNode.classList.remove('is-full');
    if (picker) { picker.value = ''; box.appendChild(picker); }
  }

  /* Random: a real generation, not a stock card. The slot carries its own
     progress so the big result overlay stays for actual runs. */
  async function roll(box, cell, rung, key, text) {
    if (cell.disabled) return;
    /* no word swap on the cell: the slot scanning is the signal, and
       relabelling it loses what the button is while you are waiting. */
    var made = false;
    /* AND THE OLD PICTURE GOES FIRST - Babe, 2026-10-26: "is there is an
       image there and you press random again can you remove the image", "so
       the loader is not over it". The waiting mark was drawn into the box on
       top of the roll you were replacing, which reads as that picture doing
       something rather than as a new one being made.
       AND THE INPUT GOES WITH IT, not just the picture. A box that has been
       emptied while it still names a file is the failure this rail keeps
       paying for: RUN would have sent the reference you can no longer see.
       NOT THE WRITING FACE. On 03 this same function generates what you
       typed, and there the box holds the sentence - clearing it would throw
       away the thing being run. */
    if (!box.classList.contains('is-ask') &&
        box.querySelector(':scope > img, :scope > video')) {
      clearSlot(box, rung, key, true);
    }
    cell.disabled = true;
    box.classList.add('is-busy');
    var wait = document.createElement('div');
    wait.className = 'wait';
    wait.innerHTML = '<i></i><i></i><i></i>';
    box.appendChild(wait);
    try {
      var res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rung: 'random',
          values: rollValues(box.closest('.slide'), text)
        })
      });
      var sub = await res.json();
      if (!res.ok) throw new Error(sub.error || 'submit failed');

      var job = await new Promise(function (resolve, reject) {
        var tick = setInterval(async function () {
          try {
            var r = await fetch('/api/job/' + sub.jobId);
            var j = await r.json();
            if (!r.ok) throw new Error(j.error || 'status failed');
            if (j.done) { clearInterval(tick); resolve(j); }
          } catch (e) { clearInterval(tick); reject(e); }
        }, 2000);
      });

      if (!job.ok) throw new Error(job.error || 'the roll failed');
      var file = job.outputs && job.outputs[0];
      if (!file) throw new Error('finished with no file');

      var c = await fetch('/api/carry', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(file)
      });
      var out = await c.json();
      if (!c.ok) throw new Error(out.error || 'carry failed');

      st(rung)[key] = out.name;
      showMedia(box, file.url, false);
      noteSlot(rung, key, lastingUrl(file), false);
      made = true;
    } catch (err) {
      say(box.closest('.slide'), String(err.message || err), true);
    } finally {
      box.classList.remove('is-busy');
      wait.remove();
      cell.disabled = false;
    }
    return made;
  }

  /* A NEW HERO MAKES THE PICTURE-TRAITS WRONG, AND ONLY THOSE - Babe,
     2026-10-29, on a sheet that dressed their Hawaiian character in the
     previous one's wetsuit: "that is not the hero", then "yeah maybe
     auto-clear", and the constraint that shapes it: "traits card should be
     info saved later for video models tho", "esp with new sesion".
     SO THE `vis` FLAG DECIDES, which is the flag that already means exactly
     this. `features` is marked "the picture shows this", is the only `vis`
     trait left after the cut from nine fields to five, and is the only one
     that reaches 02's sheet - so it is the one that ROTS when the picture
     under it is replaced. Everything else on the card is the PERFORMANCE -
     the name, the voice, how they carry themselves, how they move - which is
     what 05 and 06 are given and what the card exists to carry. Clearing
     those would throw away the thing it is for.
     IT WAS NOT AN IMAGE LEAK AND THAT IS THE POINT: the wetsuit arrived as
     WORDS, in a sentence the card had been writing into every run on this
     rung since the diver. A card describing a picture that is gone is the
     box-lying rule one level out.
     THE TEST IS THE CARD, NOT THE RUNG NUMBER. The box that has a traits
     card on its back IS the hero, wherever that ends up living. */
  function staleTraits(box) {
    var slot = box && box.closest('.slot');
    if (!slot || !slot.querySelector('.card')) return;
    var slide = slot.closest('.slide');
    var gone = 0;
    (window.HJ.traits || []).forEach(function (t) {
      if (!t.vis) return;
      var el = slide && slide.querySelector('.tf[data-t="' + t.k + '"]');
      if (el && el.textContent.trim()) { el.textContent = ''; gone++; }
    });
    if (gone) saveJourney();
  }

  async function putFile(box, file, rung, key) {
    markAct(box, null);
    /* the card is about the picture, so a new one invalidates it */
    staleTraits(box);
    /* AND IT IS AN IMPORT UNTIL SOMETHING SAYS OTHERWISE. Every file that
       arrives by hand comes through here - the chooser, a drop, and the
       capture and preset paths on their way past - and the two that are not
       imports overwrite this the moment they are done. The run reads it to
       choose a scaffolding: an imported picture is the custom case, and the
       instruction cannot assume it is a photograph of a face. */
    (st(rung).src = st(rung).src || {})[key] = 'import';
    box.classList.add('is-busy');
    try {
      var res = await fetch('/api/upload?name=' + encodeURIComponent(file.name), {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file
      });
      var out = await res.json();
      if (!res.ok) throw new Error(out.error || 'upload failed');
      st(rung)[key] = out.name;
      /* shown from the browser's own copy, which is instant; remembered as
         the server's copy of it, which is the one that survives a reload. */
      showMedia(box, URL.createObjectURL(file), /^video\//.test(file.type));
      noteSlot(rung, key, '/api/file?filename=' + encodeURIComponent(out.name) +
               '&subfolder=&type=input', /^video\//.test(file.type));
    } catch (err) {
      say(box.closest('.slide'), String(err.message || err), true);
    } finally {
      box.classList.remove('is-busy');
    }
  }

  /* THE CAMERA IS A FACE OF THE SLOT, AND THE ROW IS THAT FACE'S OWN -
     Babe, 2026-10-26: "when you press webcam the bottom panel needs to
     change with < WEBCAM header.. and then record button".
     IT WAS THE LAST CELL ON THE RAIL THAT RENAMED ITSELF. WEBCAM became
     CAPTURE, and on a clip slot it became STOP - a cell saying what pressing
     it does next, in a row whose job is to say where you are standing. That
     is what took SHEET off 04's hero frame: the row said where it would take
     you and never where you were. So opening the camera is stepping into a
     face like every other one - `< WEBCAM` and the single cell that acts -
     and the arrow beside the header puts the camera down.
     A SLOT THAT TAKES A CLIP RECORDS; A SLOT THAT TAKES A PICTURE FREEZES
     ONE. Same cell, same stream, same place - 06 asks you to act something
     out and a single frame cannot hold a performance. The slot's own
     `accept` says which it is, so nothing here needs to know about rungs,
     and it is why the cell is labelled from here rather than in the markup:
     RECORD or CAPTURE is a fact about the file chooser beside it. */
  function wantsVideo(box) {
    var picker = box.querySelector('input[type=file]');
    return !!picker && /^video\//.test(picker.accept || '');
  }

  function camCell(box) {
    var inp = box.closest && box.closest('.inp');
    return inp && inp.querySelector('.tray .tr.camgo');
  }

  /* THE PREVIEW IS BUILT IN ONE PLACE, because RETAKE puts it back and
     opening the camera puts it up, and two copies of four properties are two
     things that can disagree about which of them is muted. */
  function livePreview(box) {
    var el = document.createElement('video');
    el.className = 'cam-live';
    el.srcObject = box._stream;
    el.muted = true; el.playsInline = true; el.autoplay = true;
    box.appendChild(el);
    return el;
  }

  /* WHAT YOU SEE IS WHAT GETS SENT, which is why the mirror cannot live in
     CSS alone. `captureStream` takes the element's media, not the transform
     drawn over it, so a flipped preview would export unflipped - the exact
     shape of lie this rail refuses everywhere else. The transform is the
     preview; `cutTake` bakes it through a canvas on the way out. */
  function paintFlip(box) {
    var on = !!box._flip;
    box.querySelectorAll('.cam-live, .cam-shot').forEach(function (el) {
      el.style.transform = on ? 'scaleX(-1)' : '';
    });
    var cell = camCell(box);
    if (cell) cell.classList.toggle('is-on', on);
  }

  /* THE COUNT AND THE CLOCK ARE ONE MARK, because they are never both up: it
     counts you in and then it says how long you have been going. */
  function camMark(box, text, tick, how) {
    var el = box.querySelector('.cam-count');
    if (!text) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      box.appendChild(el);
    }
    el.className = 'cam-count' + (tick ? ' tick' : '') + (how ? ' ' + how : '');
    el.textContent = text;
  }

  /* AND IT IS CANCELLABLE, because the way out of this face is a press you can
     make while it is counting. Leaving clears the timer and the mark with the
     stream, so a count cannot land on a camera that is already down. */
  function countIn(box, from) {
    return new Promise(function (done) {
      var n = from;
      camMark(box, String(n));
      box._count = setInterval(function () {
        if (!box._stream) { clearInterval(box._count); box._count = null; return done(false); }
        n--;
        if (n > 0) return camMark(box, String(n));
        clearInterval(box._count); box._count = null;
        camMark(box, '');
        done(true);
      }, 1000);
    });
  }

  /* WHAT YOU SHOT, HELD UP RATHER THAN HANDED OVER. The stream stays open
     behind it so RETAKE is instant and the camera is not asked for twice. */
  /* `holdTake`, NOT `showShot` - THAT NAME WAS ALREADY TAKEN by the review
     panel's own showShot(panel, cell), 200 lines down. Function declarations
     hoist and the later one wins, so every stopped recording called the
     review panel with a File and died on `cell.dataset.path` - inside
     MediaRecorder's onstop, where a throw goes nowhere and the camera simply
     carried on looking at you. Measured by wrapping onstop in the page; the
     exception said "Cannot read properties of undefined (reading 'path')".
     THE SAME SHAPE AS `var say` AND `MOTION_SYS`, and neither node --check
     nor `new Function` can see it: two declarations of one name is legal
     JavaScript. The check that finds it is a scan for duplicates. */
  /* `quiet` IS A TAKE YOU DID NOT JUST SHOOT - Babe, 2026-10-27: "i wonder if
     when you go to the webcam section it should not play automatically". The
     playback below was written for the take that had just stopped recording,
     and its own reason says so: you have just performed it and the thing you
     want is to watch it. Stepping into the face over a clip that was already
     in the slot is the opposite errand - you are there to trim it, to mirror
     it or to shoot another one - and a clip that starts talking at you the
     moment you arrive is answering a question nobody asked. */
  function holdTake(box, file, secs, quiet) {
    var live = box.querySelector('.cam-live');
    if (live) live.remove();
    box._shot = file;
    box._shotUrl = URL.createObjectURL(file);
    var vid = /^video\//.test(file.type);
    var el = document.createElement(vid ? 'video' : 'img');
    el.className = 'cam-shot';
    if (vid) { el.controls = true; el.loop = true; el.playsInline = true; }
    el.src = box._shotUrl;
    box.appendChild(el);
    if (vid) {
      /* THE TRANSPORT IS OURS, so the take is the only thing on screen that
         is not drawn by this page. The native bar brought its own type, its
         own grey and a menu offering to download the take. */
      el.controls = false;
      el.loop = false;
      camStrip(box, el, secs || 0);
      /* IT PLAYS ITSELF BACK. You have just performed it and the thing you
         want is to watch it, not to press play - with sound, because half of
         what you are judging is what you said. The press that stopped the
         recorder is a user gesture, so unmuted playback is allowed here; a
         browser that refuses anyway leaves it on frame one with its controls,
         which is a take you can still play rather than a box doing nothing. */
      /* frame one either way, so the box is never a black rectangle while it
         decides whether to play. */
      el.preload = 'auto';
      if (!quiet) {
        var go = el.play();
        if (go && go.catch) go.catch(function () { /* frame one and controls */ });
      }
      /* AND THE CLOCK GOES WHEN THE TAKE ARRIVES, because the strip is already
         saying it - Babe, 2026-10-27: "can we remove the red 6.9s above its
         difficult to read and we already have it on the right of the
         transport". It used to be the only place the length appeared, which
         is why it was written here; the transport reads `0.0 / 6.9s` now, so
         this was the same fact drawn twice and the harder of the two to read,
         in red over the picture you are judging.
         THE MARK ITSELF STAYS - it is the countdown and the rolling clock,
         and both of those are up when there is no strip time to read. Only
         the length after the fact is gone, and `secs` still reaches the strip
         because the handles are measured from it: Chrome reports `Infinity`
         for a MediaRecorder blob's duration, so the recorder's own elapsed
         time is the only honest answer for a take it made. */
      camMark(box, '');
    }
    var slot = box.closest('.slot');
    if (slot) slot.classList.add('is-shot');
    var go = box.querySelector('.cam-trim .rec');
    if (go) go.classList.remove('is-rolling');
  }

  /* TWO HANDLES AND A TRANSPORT, WHICH ARE THE SAME LINE - Babe, 2026-10-27:
     "we may want to make a simple trim in and out handles to cut off anything
     we dont want to use", then "the playback panel can be custom". A take
     always has a second of reaching for the keyboard at each end, and this
     rail asks for four to ten seconds, so the difference is most of a shot.
     THE RANGE YOU SET IS THE RANGE IT PLAYS, which is why there is no second
     scrubber: the loop runs between the handles, so what you are watching is
     exactly what USE will send. */
  /* THE PANEL IS THERE FROM THE MOMENT THE CAMERA IS - Babe, 2026-10-27:
     "when you press webcam. can you just show the panel there". It opened only
     once a take existed, so the box changed shape under you at the one moment
     you are judging a performance. It is the same strip either way; what it
     offers is what there is to do. Live it is the clock - nothing to play and
     nothing to scrub, so no play cell and no line, because a control that does
     nothing is worse than no control. With a take it gains the transport and
     the handles. */
  function camStrip(box, el, len) {
    var old = box.querySelector('.cam-trim');
    if (old) old.remove();
    /* A STILLS SLOT HAS NO STRIP AT ALL - Babe, 2026-10-27: "when you press
       webcam here it should be for capturing a still image tho", then "maybe
       it should enable since the record circle by itself is weird, we may not
       need the panel for the still capture". There is nothing to play, scrub
       or trim on a slot that takes one frame, and the first attempt at this -
       the strip with the transport hidden - left a lone red dot floating over
       the preset bust, which says less than nothing.
       SO THE RULE IS HERE RATHER THAN AT THE CALLERS: every path that draws a
       strip is covered by one test, including `retakeShot`, which would
       otherwise put one back the moment you took a photograph you did not
       want. The capture lives in the tray cell, where it was before the
       transport was built. */
    if (!wantsVideo(box)) return null;
    var wrap = document.createElement('div');
    wrap.className = 'cam-trim' + (el ? '' : ' is-live');
    wrap.innerHTML =
      /* RECORD IS ON THE STRIP AND IT IS A RED CIRCLE - Babe, 2026-10-27: "add
         a red circle to record next to play", "record on the left". The row
         below is the face's own row and this is the camera's transport, so the
         press that rolls belongs here beside the press that plays. It leaves
         the tray a cell, which is where FLIP went. */
      '<button class="rec" type="button" aria-label="Record"></button>' +
      '<button class="pp" type="button" aria-label="Play"></button>' +
      '<div class="bar"><div class="kept"></div><div class="at"></div>' +
        '<div class="h in" data-end="in"></div><div class="h out" data-end="out"></div></div>' +
      '<div class="t"></div>';
    /* AND THE RECORD PRESS IS THE ONE THE CELL USED TO MAKE. The box carries
       which workflow and which slot it belongs to, because the strip is built
       in two places and neither of them is the tray. */
    wrap.querySelector('.rec').addEventListener('click', function (e) {
      e.stopPropagation();
      var rk = box._rk || {};
      camAct(box, rk.rung, rk.key);
    });
    box.appendChild(wrap);
    paintFlip(box);
    if (!el) {
      /* AND IT SAYS NOTHING UNTIL THERE IS SOMETHING TO SAY - Babe: "remove
         flip ready". A word standing in for a number is worse than the space
         the number will take. */
      wrap.querySelector('.t').textContent = box._noMic ? 'no mic' : '0.0s';
      return wrap;
    }
    return trimBar(box, el, len, wrap);
  }

  function trimBar(box, el, len, wrap) {

    var bar = wrap.querySelector('.bar');
    var kept = wrap.querySelector('.kept');
    var at = wrap.querySelector('.at');
    var hIn = wrap.querySelector('.h.in');
    var hOut = wrap.querySelector('.h.out');
    var pp = wrap.querySelector('.pp');
    var tt = wrap.querySelector('.t');

    box._len = len; box._in = 0; box._out = len;

    /* A TAKE WHOSE CONTAINER HAS NO DURATION CANNOT BE SEEKED, so it cannot
       be trimmed either - Chrome writes no duration into a MediaRecorder webm
       and seeking it does nothing. It keeps the transport and loses the
       handles, which is the honest version of a control that would not work.
       `len` is still the recorder's own measurement either way. */
    el.addEventListener('loadedmetadata', function () {
      wrap.classList.toggle('no-seek', !isFinite(el.duration));
    });

    function pct(s) { return (len ? Math.max(0, Math.min(1, s / len)) : 0) * 100; }
    function draw() {
      /* A STRIP DESCRIBES A TAKE, so once the take is gone it has nothing to
         say. Removing the video does not remove its listeners, and the
         `timeupdate` that arrives as it is torn down was re-creating the
         corner mark a moment after the teardown had cleared it. */
      if (!box._shot || !el.isConnected) return;
      /* WHILE IT CUTS, THE CORNER IS SAYING SO and this must not write over
         it: the cut is a real-time playback, so the length would read as a
         video simply playing - which is what the two presses looked like. */
      if (box._cutting) { at.style.left = pct(el.currentTime) + '%'; return; }
      kept.style.left = pct(box._in) + '%';
      kept.style.width = (pct(box._out) - pct(box._in)) + '%';
      hIn.style.left = pct(box._in) + '%';
      hOut.style.left = pct(box._out) + '%';
      at.style.left = pct(el.currentTime) + '%';
      tt.textContent = el.currentTime.toFixed(1) + ' / ' + (box._out - box._in).toFixed(1) + 's';
      /* AND THE CORNER NO LONGER SAYS THE LENGTH, because the strip says it -
         Babe, 2026-10-27: "can we remove the red 6.9s above its difficult to
         read and we already have it on the right of the transport", and then
         "still seeing the red duration on the video tho" after it was taken
         off the take. This is why: it was written when the corner WAS the
         only place a length appeared, and it repaints on every frame, so
         clearing it anywhere else lasted exactly one tick.
         THE RIGHT-HAND NUMBER IS THE SAME FACT - `.t` reads
         `currentTime / kept`, so what you would keep is already on the strip
         and in the easier place to read it. The mark keeps the things that
         are not the length and could not be anywhere else: the countdown,
         the rolling clock, `Cutting` and `saved`. */
      if (!box._saidUntil || Date.now() > box._saidUntil) camMark(box, '');
    }

    el.addEventListener('timeupdate', function () {
      /* AND THE RANGE DOES NOT LOOP WHILE IT IS BEING EXPORTED. The cut plays
         the take from in to out and watches for the out point; this handler
         was rewinding to the in point a frame before it got there, so the
         watcher never saw the end and the export never finished. Two things
         driving one playhead, and the one that is recording wins. */
      if (box._cutting) return draw();
      if (el.currentTime >= box._out - 0.04 || el.currentTime < box._in - 0.25) {
        el.currentTime = box._in;
      }
      draw();
    });
    el.addEventListener('play', function () { pp.classList.add('is-on'); });
    el.addEventListener('pause', function () { pp.classList.remove('is-on'); });
    pp.addEventListener('click', function (e) {
      e.stopPropagation();
      if (el.paused) el.play(); else el.pause();
    });

    function secAt(ev) {
      var r = bar.getBoundingClientRect();
      return Math.max(0, Math.min(len, ((ev.clientX - r.left) / (r.width || 1)) * len));
    }
    /* A HANDLE CANNOT CROSS THE OTHER ONE, and it cannot land on it either:
       a zero-length take is a button that would export nothing. */
    function hold(h, end) {
      h.addEventListener('pointerdown', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        h.setPointerCapture(ev.pointerId);
        h.classList.add('is-held');
        var move = function (e) {
          var s = secAt(e);
          if (end === 'in') box._in = Math.min(s, box._out - 0.3);
          else box._out = Math.max(s, box._in + 0.3);
          /* SCRUBBING TO THE HANDLE YOU ARE HOLDING, so you are cutting
             against the frame rather than against a number. */
          el.currentTime = end === 'in' ? box._in : Math.max(box._in, box._out - 0.05);
          draw();
        };
        var up = function () {
          h.classList.remove('is-held');
          h.removeEventListener('pointermove', move);
          h.removeEventListener('pointerup', up);
          el.currentTime = box._in;
          if (el.paused) el.play();
        };
        h.addEventListener('pointermove', move);
        h.addEventListener('pointerup', up);
      });
    }
    hold(hIn, 'in');
    hold(hOut, 'out');

    bar.addEventListener('click', function (ev) {
      if (ev.target.closest('.h')) return;
      var s = secAt(ev);
      el.currentTime = Math.max(box._in, Math.min(box._out, s));
      draw();
    });

    draw();
  }

  /* THE CUT IS A RE-RECORD, AND ONLY IF YOU CUT SOMETHING. There is no
     ffmpeg here and there is not going to be - the server has no dependencies
     and neither does the page - so a trimmed take is played back into a
     second recorder through the element's own captureStream. It costs the
     length of the range in real time, which is a few seconds for a shot this
     rail asks four to ten of.
     UNTRIMMED IS UNTOUCHED: the file the camera produced goes as it is, with
     no second encode and nothing to wait for. */
  async function cutTake(box) {
    var file = box._shot;
    if (!file || !/^video\//.test(file.type)) return file;
    var el = box.querySelector('.cam-shot');
    var len = box._len || 0, a = box._in || 0, b = box._out || len;
    if (!el || !len || !el.captureStream || !isFinite(el.duration)) return file;
    /* UNTRIMMED AND UNFLIPPED IS UNTOUCHED. Either one makes this a different
       picture from the one the camera produced, and then it has to be made. */
    if (a < 0.05 && b > len - 0.05 && !box._flip) return file;

    /* AND IT SAYS IT IS CUTTING, on the strip and on the row, because the
       only other thing on screen is the take playing. */
    var slot = box.closest('.slot');
    var strip = box.querySelector('.cam-trim');
    box._cutting = true;
    if (slot) slot.classList.add('is-cutting');
    if (strip) strip.classList.add('is-cutting');
    /* AND IT IS THE BIG MARK, NOT THE CORNER ONE - Babe, 2026-10-27:
       "cutting does not really stand out that well". The cut IS the take
       playing, so the only thing telling the two apart is the word, and a
       word in the corner at 13px is not a difference anybody notices. It
       wears the countdown's own treatment - over the picture, on the scrim -
       at a size a word can live at. */
    camMark(box, 'Cutting', false, 'word');

    /* A MIRROR IS DRAWN, NOT DECLARED. The element's own stream is the true
       image whatever CSS is doing to it, so a flipped take goes through a
       canvas: the frames are drawn mirrored and the take's own audio track is
       carried across, because a canvas has none. */
    var src = el.captureStream();
    var stream = src, cv = null, raf = null;
    if (box._flip) {
      cv = document.createElement('canvas');
      cv.width = el.videoWidth || 1280;
      cv.height = el.videoHeight || 720;
      var cx = cv.getContext('2d');
      stream = cv.captureStream(30);
      src.getAudioTracks().forEach(function (t) { stream.addTrack(t); });
      var paint = function () {
        cx.save();
        cx.scale(-1, 1);
        cx.drawImage(el, -cv.width, 0, cv.width, cv.height);
        cx.restore();
        raf = requestAnimationFrame(paint);
      };
      paint();
    }
    var type = MediaRecorder.isTypeSupported(file.type) ? file.type : '';
    var rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    var parts = [];
    rec.ondataavailable = function (e) { if (e.data && e.data.size) parts.push(e.data); };
    var done = new Promise(function (r) { rec.onstop = r; });

    var was = el.loop;
    el.loop = false;
    el.pause();
    el.currentTime = a;
    await new Promise(function (r) {
      var go = function () { el.removeEventListener('seeked', go); r(); };
      el.addEventListener('seeked', go);
    });
    rec.start();
    await el.play();
    /* AND IT CANNOT WAIT FOR EVER. A take whose duration is a hair under the
       measured length would never reach the out point, so the watch gives up
       a second past the range it asked for and keeps what it has. */
    var cap = Date.now() + (b - a) * 1000 + 1500;
    await new Promise(function (r) {
      var watch = setInterval(function () {
        if (el.currentTime >= b - 0.03 || el.ended || Date.now() > cap) {
          clearInterval(watch); r();
        }
      }, 30);
    });
    el.pause();
    rec.stop();
    await done;
    if (raf) cancelAnimationFrame(raf);
    el.loop = was;
    box._cutting = false;
    if (slot) slot.classList.remove('is-cutting');
    if (strip) strip.classList.remove('is-cutting');
    var kind = rec.mimeType || file.type;
    var ext = /mp4/.test(kind) ? 'mp4' : 'webm';
    return new File([new Blob(parts, { type: kind })], 'performance.' + ext, { type: kind });
  }

  function dropShot(box) {
    var shot = box.querySelector('.cam-shot');
    if (shot) shot.remove();
    var trim = box.querySelector('.cam-trim');
    if (trim) trim.remove();
    box._len = box._in = box._out = null;
    /* AND THE LENGTH GOES WITH THE TAKE IT MEASURED. It survived RETAKE once,
       which put the last take's duration over the live preview of the next
       one - a mark describing something that is no longer in the box. */
    camMark(box, '');
    if (box._shotUrl) { URL.revokeObjectURL(box._shotUrl); box._shotUrl = null; }
    box._shot = null;
    var slot = box.closest('.slot');
    if (slot) slot.classList.remove('is-shot');
  }

  async function retakeShot(box) {
    /* AND RETAKE OVER A CLIP YOU DID NOT SHOOT IS A REQUEST FOR THE CAMERA.
       The face can be entered on the slot's own clip now, so this can be
       pressed with no stream behind it - and the guard that used to be
       correct there made a lit cell that did nothing, which is the one thing
       this rail must never draw. It means "shoot another one" either way; the
       only difference is whether the camera is already open. The clip that
       was set aside on the way in stays set aside, because `webcam` keeps the
       first set-aside rather than replacing it. */
    if (!box._stream) {
      var rk = box._rk || {};
      dropShot(box);
      return webcam(box, rk.rung, rk.key);
    }
    dropShot(box);
    livePreview(box);
    camStrip(box, null, 0);
    var go = camCell(box);
    if (go) go.classList.remove('is-rolling');
  }

  /* USE IS THE ACCEPTANCE, and it is the only press that fills the slot. */
  async function useShot(box, rung, key) {
    if (!box._shot) return;
    /* THE CUT HAPPENS ON THE WAY OUT, so a take you never trimmed costs
       nothing and a trimmed one is cut once, here, rather than on every
       press that looks at it. */
    /* AND IT IS THE BIG MARK, NOT THE CORNER ONE - Babe, 2026-10-27:
       "cutting does not really stand out that well". The cut IS the take
       playing, so the only thing telling the two apart is the word, and a
       word in the corner at 13px is not a difference anybody notices. It
       wears the countdown's own treatment - over the picture, on the scrim -
       at a size a word can live at. */
    camMark(box, 'Cutting', false, 'word');
    var file = await cutTake(box);
    var fromCam = !wantsVideo(box);
    dropShot(box);
    box._camWas = null;
    stopCam(box);
    await putFile(box, file, rung, key);
    /* WHERE IT CAME FROM, BECAUSE THE INSTRUCTION DEPENDS ON IT. A frame off
       a webcam is a photograph of you in a room with a ceiling light, and the
       scaffolding has to keep your face while refusing all of that - see
       CAM_SYS. Recorded rather than pressed: this is provenance, not a cell
       naming a file, and `putFile` writes `import` on its way past. */
    if (fromCam) {
      (st(rung).src = st(rung).src || {})[key] = 'webcam';
      saveJourney();
    }
  }

  function enterCam(box, label) {
    var slot = box.closest('.slot');
    if (slot) {
      slot.classList.add('is-cam', 'is-inface');
      /* AND A STILLS CAMERA IS NAMED, because the row it wants is not the
         clip slot's row - Babe, 2026-10-27: "we dont need the same options
         or countdown for the webcam". Which camera this is has always been
         read off the file chooser's accept, and it is written here rather
         than at the three call sites so no path into the face can arrive
         without it. */
      slot.classList.toggle('is-stills', !wantsVideo(box));
      var head = slot.querySelector('.tray .tray-k');
      if (head) {
        if (head.dataset.camWas === undefined) head.dataset.camWas = head.innerHTML;
        head.innerHTML = '<b>Webcam</b>';
      }
    }
    var go = camCell(box);
    if (go) { go.textContent = label; go.classList.remove('is-live'); }
  }

  /* PUTTING THE CAMERA DOWN IS PUTTING THE ROW BACK. The header is restored
     from what it was rather than written as a word, because what it says at
     rest belongs to the slot: PROMPT on a writing box, the mode and the face
     on a form. */
  function stopCam(box) {
    if (box._stream) box._stream.getTracks().forEach(function (t) { t.stop(); });
    box._stream = null;
    /* THE COUNT, THE CLOCK AND THE TAKE GO WITH THE STREAM. A timer left
       running past the camera is a mark painted over whatever comes back -
       the same shape as the waiting mark that got snapshotted into a hint. */
    clearInterval(box._count); box._count = null;
    clearInterval(box._tick); box._tick = null;
    clearTimeout(box._said); box._said = null;
    box._cutting = false; box._saidUntil = 0;
    camMark(box, '');
    var slot = box.closest('.slot');
    if (slot) {
      slot.classList.remove('is-cam', 'is-inface', 'is-shot', 'is-stills');
      var head = slot.querySelector('.tray .tray-k');
      if (head && head.dataset.camWas !== undefined) {
        head.innerHTML = head.dataset.camWas;
        delete head.dataset.camWas;
      }
    }
    var go = camCell(box);
    if (go) { go.textContent = ''; go.classList.remove('is-live'); }
  }

  /* WHAT WAS IN THE BOX IS MOVED OUT, NOT THROWN AWAY. The preview needs the
     box to itself, and leaving the camera without taking anything has to put
     back the picture that was there - the `_was` lesson from the writing
     face, where restoring the empty-slot HINT over a real picture made the
     slot lie about its own contents. The nodes are kept rather than their
     markup, so a clip does not reload to be looked away from.
     THE PICKER STAYS, because it is furniture: `wantsVideo` reads its accept
     while the preview is up, and that is the one thing deciding whether this
     face records or freezes. */
  /* THE FACE OPENS ON WHAT YOU HAVE; THE CAMERA WAITS TO BE ASKED - Babe,
     2026-10-27: "i feel like we should just keep the panel in case you want to
     edit the in and out", "so that dialogue only comes up after you are in the
     section". Pressing WEBCAM used to call getUserMedia on the way in, which
     spent the permission prompt before you had decided to record and put the
     clip you were holding behind a live preview - so stepping in to look at
     your own take was the one way to be at risk of losing it.
     THE CLIP IN THE SLOT IS TREATED AS THE CURRENT TAKE, and that is what
     makes the trim free: `holdTake` already draws a take with the transport
     and the handles, `cutTake` already cuts the range on the way out and
     hands back the file untouched when nothing was trimmed, and `useShot`
     already puts the result in the slot. Nothing new had to learn what a
     range is. A real file also has a finite `duration`, so the handles work
     here - the `Infinity` the strip has to measure around belongs to
     MediaRecorder's own webm and not to a file that came off disk.
     RECORD IS THE ONLY THING THAT ASKS FOR THE CAMERA, and it is already its
     own button on the strip. */
  async function openCamFace(box, rung, key) {
    if (box._stream || box._shot) return;
    /* AND A STILLS SLOT GOES STRAIGHT TO THE CAMERA. Waiting for a second
       press is what the clip slot needs, because stepping in there is how you
       look at, trim or keep a take you already have; a stills slot has none
       of that to offer, so the face would be a photograph you cannot act on
       with one button floating over it. Pressing WEBCAM there means the one
       thing it can mean. */
    if (!wantsVideo(box)) return webcam(box, rung, key);
    box._rk = { rung: rung, key: key };
    if (box.dataset.hint === undefined) box.dataset.hint = bareHTML(box);

    var cur = box.querySelector('video');
    var src = cur && (cur.currentSrc || cur.src);
    if (cur && wantsVideo(box)) {
      /* TWO WAYS TO THE BYTES, BECAUSE THE BOX IS PAINTED FROM EITHER. What a
         clip slot is showing is an object URL when this sitting put it there
         and a path under output/ when `fill` or a restore did - and an object
         URL does not survive the page that made it, so reading the element's
         own `src` is right exactly half the time. `fromFile` is the other
         half, and it is already the one field that records what the box is
         painted from. */
      var file = null;
      var why = '';
      var tries = [src, box.dataset.fromFile ? '/' + box.dataset.fromFile : ''];
      for (var t = 0; t < tries.length && !file; t++) {
        if (!tries[t]) continue;
        try {
          var got = await fetch(tries[t]);
          if (!got.ok) { why = 'HTTP ' + got.status; continue; }
          var blob = await got.blob();
          if (!blob.size) { why = 'empty'; continue; }
          file = new File([blob], 'clip.' + (/webm/.test(blob.type) ? 'webm' : 'mp4'),
                          { type: blob.type || 'video/mp4' });
        } catch (err) { why = err.message || String(err); }
      }
      /* AND A FAILURE SAYS SO RATHER THAN DRAWING AN EMPTY TRACK. Falling
         through quietly is what made a clip on screen sit over a transport
         reading 0.0s, which reads as the panel being broken rather than as
         this one read having failed. */
      if (!file) {
        console.warn('[hj] could not load the clip into the transport:', why, tries);
        say(box.closest('.slide'), 'could not read the clip for the transport', true);
      }
      if (file) {
        var len = cur.duration && isFinite(cur.duration) ? cur.duration : 0;
        /* SET ASIDE, NOT THROWN AWAY - the same move the camera makes, so
           backing out puts the clip you arrived with back exactly as it was
           rather than a second copy of it built from markup. */
        var picker = box.querySelector('input[type=file]');
        var kept = document.createDocumentFragment();
        [].slice.call(box.childNodes).forEach(function (n) {
          if (n !== picker) kept.appendChild(n);
        });
        box._camWas = kept;
        /* THE MIRROR IS OFFERED HERE TOO, because what is in the box is a take
           like any other once it is held as one - Babe: "we prob should still
           add the flip option in this view too". */
        enterCam(box, 'Flip');
        /* quiet: this one was already in the slot - see holdTake. */
        holdTake(box, file, len, true);
        return;
      }
    }
    /* nothing to look at yet: the face is the strip, dim, with RECORD lit -
       which is what it has looked like since the transport stopped arriving
       with the take. */
    enterCam(box, '');
    camStrip(box, null, 0);
    box.classList.add('is-filled');
    if (box.parentNode) box.parentNode.classList.add('is-full');
  }

  async function webcam(box, rung, key) {
    if (box._stream) return;
    try {
      var vid = wantsVideo(box);
      var stream = await navigator.mediaDevices.getUserMedia(
        vid ? { video: { width: 1280, height: 720 }, audio: true }
            : { video: { width: 1280, height: 1280 } });
      /* NOTHING IN THE TRAY IS PRESSED WHILE THE CAMERA IS LOOKING AT YOU -
         Babe, 2026-10-26: "if you use webcam we should unhighlight preset".
         PRESET stayed lit over a live preview, which is the one lie this rail
         cannot afford twice: a cell saying the box holds a particular file
         while the box holds something else entirely. Cleared here rather than
         on capture, because the preset stops being what you are looking at
         the moment the camera opens. */
      markAct(box, null);
      box._stream = stream;
      if (box.dataset.hint === undefined) box.dataset.hint = bareHTML(box);
      var picker = box.querySelector('input[type=file]');
      var kept = document.createDocumentFragment();
      [].slice.call(box.childNodes).forEach(function (n) {
        if (n !== picker) kept.appendChild(n);
      });
      /* AND THE FIRST SET-ASIDE WINS. The face may already have moved the
         slot's own clip out of the way on the way in, and overwriting that
         with what the face itself put there would restore the take over the
         clip it replaced. */
      if (!box._camWas) box._camWas = kept;
      /* THE BOX KNOWS WHOSE IT IS, because the strip's record button is built
         by camStrip and camStrip is not the tray. */
      box._rk = { rung: rung, key: key };
      /* AND A PERFORMANCE WITH NO MICROPHONE IS A WASTED TAKE, so the strip
         says so before you give one. The constraint asks for audio on a clip
         slot and a browser can hand back video alone - a blocked mic, a
         device in use - without failing, which is the quietest way to lose
         six seconds of someone acting. */
      box._noMic = vid && !stream.getAudioTracks().length;
      livePreview(box);
      camStrip(box, null, 0);
      box.classList.add('is-filled');
      if (box.parentNode) box.parentNode.classList.add('is-full');
      /* THE CELL IS THE MIRROR ON A CLIP SLOT AND THE SHUTTER ON A STILLS
         ONE, because that is what is left to do in each: recording moved to
         the strip and a stills slot has no strip to move it to. */
      enterCam(box, wantsVideo(box) ? 'Flip' : 'Capture');
    } catch (err) {
      box._stream = null;
      say(box.closest('.slide'), 'no camera: ' + (err.message || err), true);
    }
  }

  /* LEAVING WITH NOTHING IS A REAL ANSWER: you opened the camera to look at
     it. The preview goes, what was behind it comes back, and a box that had
     nothing in it is empty again rather than claiming to hold a stream that
     has stopped. */
  function cancelCam(box) {
    /* AND LEAVING A FACE THAT NEVER OPENED THE CAMERA IS STILL LEAVING IT -
       Babe, 2026-10-27: "or if you go to webcam you can get back", "without
       loading the web-cam". The face is entered before the stream exists now,
       so a guard on the stream was a guard that refused to let you out of a
       room you walked into. The question is whether there is a face to leave,
       and the three things that put you in one are the stream, a take, and
       the class the face itself wears. */
    var slot = box.closest && box.closest('.slot');
    var inFace = !!box._stream || !!box._shot ||
                 !!(slot && slot.classList.contains('is-cam'));
    if (!inFace) return;
    stopCam(box);
    /* THE TAKE GOES THROUGH THE ONE FUNCTION THAT KNOWS WHAT A TAKE IS. This
       listed the pieces by hand - first `querySelector('video')`, which found
       the preview or the take and left the other standing, then both by name,
       and then the trim strip grew and was left behind on the way out. A list
       of parts is a list that goes stale; `dropShot` is the part list. */
    dropShot(box);
    var live = box.querySelector('.cam-live');
    if (live) live.remove();
    if (box._camWas) { box.appendChild(box._camWas); box._camWas = null; }
    var holds = !!box.querySelector(':scope > img, :scope > video');
    box.classList.toggle('is-filled', holds);
    if (box.parentNode) box.parentNode.classList.toggle('is-full', holds);
  }

  /* RECORD ROLLS UNTIL YOU PRESS IT AGAIN. The file is whatever the browser
     will encode - webm on Chrome - and it uploads like any other, which is
     the one thing already proven about this rung: an mp4 round-trips into
     Comfy's input store and comes back content-hashed. */
  function rollCam(box, rung, key) {
    var go = box.querySelector('.cam-trim .rec');
    if (!window.MediaRecorder) {
      return say(box.closest('.slide'), 'this browser cannot record', true);
    }
    /* whatever this browser will actually encode, asked for best first */
    var type = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find(function (t) {
      return MediaRecorder.isTypeSupported(t);
    });
    var rec = new MediaRecorder(box._stream, type ? { mimeType: type } : undefined);
    var parts = [];
    box._rec = rec;
    rec.ondataavailable = function (e) { if (e.data && e.data.size) parts.push(e.data); };
    rec.onstop = function () {
      var kind = rec.mimeType || type || 'video/webm';
      var blob = new Blob(parts, { type: kind });
      box._rec = null;
      clearInterval(box._tick); box._tick = null;
      camMark(box, '');
      if (go) go.classList.remove('is-rolling');
      /* THE TAKE IS SHOWN, NOT SENT. Leaving while it rolls still stops it,
         and what that press buys you now is the take to look at rather than a
         slot already filled with it. */
      var ext = /mp4/.test(kind) ? 'mp4' : 'webm';
      if (box._stream) {
        holdTake(box, new File([blob], 'performance.' + ext, { type: kind }),
                 (Date.now() - t0) / 1000);
      }
    };
    rec.start();
    if (go) go.classList.add('is-rolling');
    /* HOW LONG YOU HAVE BEEN GOING, because this rail asks for four to ten
       seconds and a performance you cannot time is one you shoot twice. */
    var t0 = Date.now();
    /* THE CLOCK IS ON THE STRIP NOW, not in the corner: the panel is there
       while the camera is, so the one number it has to show belongs in it. */
    var tt = box.querySelector('.cam-trim .t');
    if (tt) tt.classList.add('is-rolling');
    box._tick = setInterval(function () {
      var s = (Date.now() - t0) / 1000;
      if (tt) tt.textContent = '● ' + s.toFixed(1) + 's';
    }, 100);
  }

  async function camAct(box, rung, key) {
    /* RECORD IS WHERE THE PERMISSION PROMPT LIVES NOW. Entering the face no
       longer opens the camera, so the first press of this is what asks for
       it - and a refusal says so through `webcam`'s own catch rather than
       failing silently here. */
    if (!box._stream) {
      /* whatever is being looked at goes, because recording replaces it and
         a take standing behind a live preview is two answers to one box. */
      if (box._shot) dropShot(box);
      await webcam(box, rung, key);
      if (!box._stream) return;
    }
    /* STOP IS THE SAME CELL AND IT DOES NOT COUNT YOU IN AGAIN. */
    if (box._rec) return box._rec.stop();
    if (box._count) return;
    /* THREE, TWO, ONE IN FRONT OF A TAKE, AND NOTHING IN FRONT OF A
       PHOTOGRAPH - Babe, 2026-10-27: "we dont need the same options or
       countdown for the webcam". A take that opens on you reaching for the
       keyboard has spent the first second of a performance, which is why the
       count was written. A still is one frame of a pose you are already
       holding: counting somebody in to it puts three seconds in front of a
       press that is instant, and a bad one costs a RETAKE, which costs
       nothing. */
    if (wantsVideo(box)) {
      if (!(await countIn(box, 3))) return;
      if (!box._stream) return;
      return rollCam(box, rung, key);
    }
    /* THE CAPTURE IS CROPPED TO THE ROW'S AR, because rung 01's graph takes
       its output size from the input image - TextEncodeQwenImage21 has
       resolution 0 and there is no EmptyLatentImage, so a 16:9 webcam frame
       produces a 16:9 character. Crop here and AR means something here. */
    var v = box.querySelector('video');
    var want = (param(box.closest('.slide'), 'ar') || '1:1').split(':');
    var ratio = (+want[0] || 1) / (+want[1] || 1);
    var sw = v.videoWidth, sh = v.videoHeight;
    var cw = Math.min(sw, sh * ratio), ch = Math.min(sh, sw / ratio);
    var c = document.createElement('canvas');
    c.width = Math.round(cw); c.height = Math.round(ch);
    c.getContext('2d').drawImage(v, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, c.width, c.height);
    var blob = await new Promise(function (r) { c.toBlob(r, 'image/png'); });
    holdTake(box, new File([blob], 'webcam.png', { type: 'image/png' }));
  }

  /* ONE LISTENER FOR BOTH DECISIONS, bound where the camera's own cell is. */
  function bindShot(box, rung, key) {
    var inp = box.closest && box.closest('.inp');
    if (!inp) return;
    inp.querySelectorAll('.tray .tr.camr').forEach(function (cell) {
      cell.addEventListener('click', async function () {
        if (cell.dataset.cam === 'use') return useShot(box, rung, key);
        if (cell.dataset.cam === 'retake') return retakeShot(box);
        /* SAVE KEEPS WHAT YOU ARE LOOKING AT, which is the trimmed range and
           not the raw take - the strip says what it is and the file should
           agree with the strip. It is named the way the result panel names a
           download, because it is the same act. */
        var file = await cutTake(box);
        /* AND IT IS KEPT WITH THE SESSION, so it turns up in the media panel
           beside everything else this sitting made - Babe: "when you save does
           it go to media panel?". The download is the copy you can take to
           another machine; this is the copy that stays with the work. A
           server that will not keep it is not a reason to lose the file, so
           the download happens either way and the strip says which it got. */
        var kept = await fetch('/api/take?name=' + encodeURIComponent(file.name), {
          method: 'POST',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: file
        }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(file);
        a.download = 'heros-journey-take-' +
                     new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '') + '.' +
                     (/mp4/.test(file.type) ? 'mp4' : /webm/.test(file.type) ? 'webm' : 'png');
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
        /* AND IT SAYS SO - Babe: "can't tell if it saved". A download that
           goes straight to a folder leaves nothing on screen, so the mark
           that has been reporting this take all along reports this too, and
           then goes back to saying how long it is. */
        camMark(box, kept ? 'saved · in media' : 'saved', true);
        box._saidUntil = Date.now() + 2200;
        clearTimeout(box._said);
        /* and then gets out of the way, rather than going back to saying a
           length the strip has been showing the whole time. */
        box._said = setTimeout(function () {
          if (box._shot) camMark(box, '');
        }, 1800);
      });
    });
  }

  /* AND THE ARROW IS THE WAY OUT OF THE CAMERA, the same press that leaves
     every other face. It claims the event, because the handler that closes a
     writing face and the one that steps out of a panel are both listening
     for this cell. A press while the recorder is rolling stops it, which is
     the one way out that keeps what you just shot. */
  document.addEventListener('click', function (e) {
    var k = e.target.closest &&
            e.target.closest('.slot.is-cam .tray-k, .slot.is-cam .tr.back');
    if (!k) return;
    e.__backDone = 1;
    var slot = k.closest('.slot');
    /* WHICH BOX IS WEARING THE FACE, NOT WHICH BOX HAS A STREAM. This looked
       for `_stream` because the face and the camera used to arrive together -
       and now that the face can be entered on the slot's own clip, a press
       here found nothing to cancel while `__backDone` above had already told
       the OTHER back handler to stand down. The result was a half-exit:
       `is-inface` came off, `is-cam` and the take stayed, and the arrow that
       draws only inside a face went with it, so there was no way out at all.
       Measured in the page, 2026-10-27. A take and the face's own strip are
       both as good an answer as a stream. */
    var drops = [].slice.call(slot.querySelectorAll('.drop'));
    var live = drops.find(function (b) { return b._stream; });
    if (live && live._rec) return live._rec.stop();
    var held = live || drops.find(function (b) {
      return b._shot || b.querySelector('.cam-trim');
    });
    if (held) cancelCam(held);
  });
  function openAsk(box, cell) {
    /* AND THE NOTE GOES WHEN THE FACE CHANGES UNDER IT, because it is about
       the mode you were on and a tab press is how you leave one. */
    var whySlot = box.closest && box.closest('.slot');
    if (whySlot) whyOff(whySlot);
    /* AND SO IS PROMPT. It used to refuse while the camera was open, which
       left the take looping behind the writing box with its sound on; the
       press means "I am writing now", so the camera goes down and the box is
       the sentence. */
    if (box._stream) cancelCam(box);
    /* `hint` IS THE EMPTY SLOT AND `_was` IS WHAT WAS SHOWING, AND THEY ARE
       NOT THE SAME THING. One field was doing both: `hint` is captured once,
       the first time any face opens, so it holds whatever the box contained
       THEN - usually the empty-slot hint - and closing the writing face put
       that back over the picture you had since put in. Babe, 2026-10-25:
       "when changing modes the random image did not persist", "but if i
       click prompt". Measured: after PROMPT then a tab press the box was
       `is-filled` with nothing in it, which is the slot lying about its own
       contents in the one way this rail cannot afford.
       THE PICKER IS TAKEN OUT BEFORE THE SNAPSHOT, because it is a live
       element with a listener on it: serialising it and restoring it from
       markup would hand back a dead one. */
    if (box.dataset.hint === undefined) box.dataset.hint = bareHTML(box);
    var picker = box.querySelector('input[type=file]');
    if (picker) picker.remove();
    box._was = bareHTML(box);
    /* THE PICTURE STAYS, BEHIND THE GLASS. It is the subject of the sentence
       being typed over it, and this face has had the glass treatment all
       along with nothing behind it to see. The live node is kept rather than
       re-made, so a video does not reload to write one word over it. */
    var plate = box.querySelector('img, video');
    box.innerHTML = '';
    if (picker) box.appendChild(picker);
    if (plate) box.appendChild(plate);
    var field = document.createElement('div');
    field.className = 'ask';
    field.contentEditable = 'true';
    field.spellcheck = false;
    /* THE QUESTION BELONGS TO THE MODE WHERE THERE IS ONE. A tabbed slot
       asks something different on each face - STYLE wants a character, EDIT
       wants what to change - and the slide's own `ask` is the answer for a
       slot with no tabs at all. */
    var slotEl = box.closest('.slot');
    var on = slotEl && slotEl.querySelector('.ftab[aria-pressed="true"]');
    field.dataset.ph = (on && on.dataset.ask) || box.dataset.ask ||
                       'Describe a character\u2026';
    /* AND THE BOX HANDS BACK WHAT IT WAS HOLDING. Pressing a mode tab closes
       this face, so a sentence that did not survive the trip would be lost to
       a glance at the other mode. */
    if (box.dataset.said) field.textContent = box.dataset.said;
    box.appendChild(field);
    box.classList.add('is-ask');
    if (box.parentNode) box.parentNode.classList.add('is-asking');
    /* THE SAME HEADER 04'S PANEL GROWS - Babe, 2026-10-25: "we need to fix
       this to match the new panel stuff in 04 too". A box you are about to
       run something in says what will run it; GENERATE only said what the
       button beside it already says. */
    /* A BOX THAT NAMES A MODEL IS A BOX SOMETHING IN HERE RUNS. Under a mode
       where this face is the rung's own prompt, the model below the panel is
       the one that will read it and the header stays the slot's own name -
       naming it twice on one screen is the same mistake as two red buttons
       six inches apart, which this rung already fixed once. */
    var writes = slotEl && slotEl.classList.contains('writes');
    var head = box.parentNode && box.parentNode.querySelector('.tray .tray-k');
    if (head) {
      head.dataset.was = head.textContent;
      /* IT NAMES THE FACE, NOT A MODEL - Babe, 2026-10-25: "we can still
         strip out run and the model there in style", then "the header should
         prob say PROMPT". It named the roll's model while this face ran one
         of its own; the rung's RUN reads the box now and the row below names
         that model and has the picker. So the header does what it does on
         every nested panel: says where you are. `‹ PROMPT … AGENT` one level
         in, `‹ AGENT … PROMPT` two.
         THE MARKUP'S OWN GENERATE IS NEVER SEEN EITHER: it said what the
         button beside it used to say, and that button is gone. */
      faceHead(slotEl, 'Prompt');
    }
    if (!writes) cell.textContent = 'Run';
    cell.classList.remove('is-live');
    field.focus();
    field.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeAsk(box, cell); }
      /* AND ENTER IS A LINE BREAK IN A BOX THAT IS THE PROMPT - Babe,
         2026-10-29: "if you press enter while writing a prompt... instead of
         going to a line it disappears". It pressed `cell`, which was right
         when this face RAN something and that cell said GENERATE: Enter
         meant go. On a `writes` slot there is nothing to run and that cell
         is the one that steps back out of the face, so Enter closed the box
         and `closeAsk` put the empty state back over what you had typed -
         which is kept on `data-said` and looks exactly like losing it.
         THE SHAPE IS THE SAME ONE THIS FILE KEEPS: a mechanism outliving the
         thing it was for. Every writing face on the rail is `writes` now, so
         this is a line break everywhere - and the branch stays for a face
         that runs, which is what it was written for. */
      if (e.key === 'Enter' && !e.shiftKey && !writes) { e.preventDefault(); cell.click(); }
    });
  }

  /* THE HEADER STOPPED NAMING A MODEL, SO NOTHING FOLLOWS THE ROW INTO IT.
     `faceModel()` lived here while a writing tray said which model would read
     what you wrote, and it kept the two from disagreeing. The tray names the
     mode and the face now - `‹ STYLE PROMPT` - and the row below is the only
     place a model is named or chosen, so a picker that also wrote the header
     did not keep it honest, it wiped it: pressing a model with the box open
     replaced the whole address with a name. A function that was correct and
     is now wrong, left behind by the thing it was serving. */

  /* THE HEADER NAMES BOTH - Babe, 2026-10-25: "lets change the bottom header
     to read < STYLE : PROMPT and < EDIT : PROMPT". The mode is which job this
     slot is doing and the face is which side of it you are looking at, and on
     a slot where both can change the header had been saying only the second.
     THE FACE IS THE BRIGHT HALF, because it is the thing the arrow beside it
     takes you out of.
     NO COLON - Babe, 2026-10-25. The model row punctuates because it is a
     field and a value; this is a place and a face, read as one address. */
  function faceHead(slot, which) {
    if (!slot) return;
    var head = slot.querySelector('.tray .tray-k');
    if (!head) return;
    var on = slot.querySelector('.ftab[aria-pressed="true"]');
    var mode = on ? on.textContent.trim() : '';
    head.innerHTML = (mode ? mode + ' ' : '') + '<b>' + (which || 'Prompt') + '</b>';
  }
  window.HJ.faceHead = faceHead;

  /* THE PICTURE FOLLOWS THE FACE - Babe, 2026-10-25: "when you go to the
     agent. can we keep the blurred image you have loaded in the prompt". The
     agent is the second face of the writing box, so what you are writing
     about belongs behind both of them; turning the box over used to put it
     away, because the whole `.drop` is hidden on that face and the plate is
     a child of it.
     IT IS MOVED, NOT COPIED, for the reason `openAsk` keeps the node rather
     than re-making one: a `<video>` built again reloads, and two copies of a
     file are two things that can disagree about which one is showing.
     AND IT COMES BACK BEFORE ANYTHING READS THE BOX'S MARKUP. `closeAsk`
     restores `box._was` as HTML, so a plate still sitting in the panel would
     be orphaned there while a dead copy of it came back in the box - the
     slot showing a picture that is no longer the one it is holding. Calling
     this first is what makes that impossible rather than unlikely. */
  function movePlate(from, to) {
    if (!from || !to) return;
    var plate = from.querySelector(':scope > img, :scope > video');
    if (plate) to.appendChild(plate);
  }

  function facePlate(slot, toAgent) {
    if (!slot) return;
    var panel = slot.querySelector('.helper');
    /* THE BOX THE AGENT IS A FACE OF, WHICHEVER BOX THAT IS. On 01 it is the
       writing box; on 04 it is the direction form, which is the same thing
       wearing a different name - so the plate follows the agent on both
       rather than being a rule about one slot. */
    var box = slot.querySelector('.drop.is-ask') || slot.querySelector('.writer');
    if (!panel || !box) return;
    movePlate(toAgent ? box : panel, toAgent ? panel : box);
  }
  window.HJ.facePlate = facePlate;
  /* AND THE BOX READER GOES OVER TOO. The page's box face draws on the LEFT
     slot's picture, and a slot's boxes are addressed by slot and never by
     position in the slide - which is what this function is for and what the
     page cannot do for itself. Lending it beats the page walking `.drop`,
     which is the bug `boxesOf` was written to end. */
  window.HJ.boxesOf = boxesOf;

  function exitAsk(box, cell) {
    box.classList.remove('is-ask');
    if (box.parentNode) box.parentNode.classList.remove('is-asking');
    var head = box.parentNode && box.parentNode.querySelector('.tray .tray-k');
    if (head && head.dataset.was) { head.textContent = head.dataset.was; delete head.dataset.was; }
    cell.textContent = 'Prompt';
    cell.classList.remove('is-live');
  }

  /* THE HEADER IS THE WAY OUT, on this face as on the agent's. Bound here
     rather than beside the other tray-k handler because closeAsk lives in
     this file; the handler there returns early on a slot that is asking. */
  document.addEventListener('click', function (e) {
    /* the header or the arrow beside it. The arrow is a cell of its own now
       that the header names the model, and the way back has to be the thing
       that only means that. */
    var k = e.target.closest && e.target.closest('.tray .tray-k, .tray .tr.back');
    if (!k) return;
    var slot = k.closest('.slot');
    /* AND THE CARD LEAVES THE SAME WAY - Babe, 2026-10-25: "remove the x on
       the traits panel. add spacing on the traits header with the < TRAITS to
       go back". It was the last face on the rail still leaving by the corner,
       which on every other slot means throw this away. */
    if (slot && slot.classList.contains('is-describing')) {
      var cbox = slot.querySelector('.drop');
      if (cbox) { e.__backDone = 1; return closeCard(cbox); }
    }
    if (!slot || !slot.classList.contains('is-asking')) return;
    /* ONE LEVEL AT A TIME - Babe, 2026-10-25: "if you are in AGENT mode it
       should go back to prompt and not the main". The agent is a face of the
       writing box, not a third thing beside it, so the way out of it is the
       way into what it was helping with. The page's own handler owns that
       step, because 04's agent face is not a writing face and only it can
       reach both; this one steps out of the box and must not also run. */
    if (e.__backDone) return;
    if (slot.classList.contains('is-agent')) {
      var face = slot.querySelector('.tray .tr.face');
      if (face) { face.click(); e.__backDone = 1; }
      return;
    }
    var box = slot.querySelector('.drop.is-ask');
    var cell = slot.querySelector('.tray .tr[data-act="prompt"]');
    if (box && cell) closeAsk(box, cell);
  });

  /* A MODE TAB IS A WAY OUT OF A WRITING FACE THAT IS NOT ONE - Babe,
     2026-10-25: "if you click on style mode it should go back to the image /
     import / random, etc", when one tab wrote and the other did not.
     BOTH OF 01's TABS WRITE NOW, so the face survives the press - "if you go
     to edit mode can you keep it in prompt view" - and the arrow is the way
     back to the picture. The page's tab handler re-asks the question and
     renames the header; this one only still fires for a tabbed slot whose
     face is a generator rather than the rung's prompt.
     BOUND HERE for the same reason the handler above is - closeAsk lives in
     this file, and the strip itself is drawn and handled in the page. */
  document.addEventListener('click', function (e) {
    var tab = e.target.closest && e.target.closest('.ftabs .ftab');
    if (!tab) return;
    var slot = tab.closest('.slot');
    /* A TAB IS A WAY OUT OF THE CAMERA TOO, and it was not one - Babe,
       2026-10-27: "im hearing the audio and the video is not playing", "its on
       loop somewhere", "it happens when i go to edit and prompt". The take
       under review is an unmuted looping <video>; pressing a mode tab swapped
       the face over the top of it and left it playing where nobody could see
       it. Every route out of this face has to put the camera down, not just
       the arrow that was built for it. */
    if (slot) {
      [].slice.call(slot.querySelectorAll('.drop')).forEach(function (b) {
        if (b._stream) cancelCam(b);
      });
    }
    if (!slot || !slot.classList.contains('is-asking')) return;
    if (slot.classList.contains('writes')) return;
    var box = slot.querySelector('.drop.is-ask');
    var cell = slot.querySelector('.tray .tr[data-act="prompt"]');
    if (box && cell) closeAsk(box, cell);
  });

  function closeAsk(box, cell) {
    /* THE PLATE COMES HOME FIRST. It may be sitting in the agent panel, and
       everything below here rewrites the box from a string. */
    facePlate(box.closest('.slot'), false);
    /* THE BOX REMEMBERS. Under a mode where this face is the rung's prompt
       the words are the slot's content, and the face closes on a tab press,
       on Escape and on the arrow - none of which mean throw it away. */
    var said = box.querySelector('.ask');
    if (said) box.dataset.said = said.textContent.trim();
    exitAsk(box, cell);
    var picker = box.querySelector('input[type=file]');
    /* what it was showing, and only the empty hint if it was showing nothing */
    if (box._was !== undefined) { box.innerHTML = box._was; delete box._was; }
    else if (box.dataset.hint !== undefined) box.innerHTML = box.dataset.hint;
    if (picker) box.appendChild(picker);
  }

  /* THE CARD IS A SIDE OF THE SLOT, NOT A DIALOG. Every way out of it is the
     same way out: it closes, the fields keep what is in them, and the picture
     is still there. Babe, 2026-10-24 - the X closes you out of the form, it
     does not remove the image, and it does not undo your typing either. */
  function openCard(box) {
    /* a complaint from last time is not a complaint about this time */
    cardSays(box.parentNode, '');
    /* AND YOU WRITE OVER THE HERO, THE WAY YOU WRITE OVER THE PICTURE ON 01 -
       Babe, 2026-10-26: "can we show the image in the background blurred like
       we do on 01". The card is a face of this box, so the thing it is
       describing belongs behind it; the card has been glass all along with
       nothing to see through it. The live node moves rather than being
       re-made, same as the writing face. */
    movePlate(box, box.parentNode.querySelector('.card'));
    box.parentNode.classList.add('is-describing');
    /* AND IT BUILDS TOP TO BOTTOM - Babe, 2026-10-27. The card arrives as
       five rows at once, which is the one face on the rail that is a list
       rather than a picture, and a list that appears whole says nothing
       about being a list. `HJ.cascade` is `intro`'s move, borrowed: the rows
       are hidden in this same task so the finished card is never painted on
       the way in, and their inline styles are handed back at the end.
       THE MESSAGE LINE IS NOT A ROW. `.card-msg` is `display: none` while
       empty, so it has nothing to reveal, and on the open after a failed
       AUTO it is carrying the reason - which should be there to read, not
       sliding in last. */
    var card = box.parentNode.querySelector('.card');
    if (card && window.HJ && window.HJ.cascade) {
      window.HJ.cascade(card.querySelectorAll('.trait'), { stagger: 52 });
    }
    var first = box.parentNode.querySelector('.tf');
    if (first) first.focus();
  }

  function closeCard(box) {
    movePlate(box.parentNode.querySelector('.card'), box);
    box.parentNode.classList.remove('is-describing');
  }

  function bindSlot(box, rung, key, accept, altBox, altKey) {
    var picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = accept || 'image/*';
    picker.style.display = 'none';
    box.appendChild(picker);

    /* WHICHEVER FACE IS UP IS THE ONE EVERY ACTION MEANS. A two-faced slot
       shows one box at a time and each face has its own key, so IMPORT, a
       dropped file and PRESET all have to ask which one is showing rather
       than assuming the front. A one-faced slot answers the same question
       with the only box it has. */
    function face() {
      var on = altBox && box.parentNode.classList.contains('is-flipped');
      return on ? { box: altBox, key: altKey } : { box: box, key: key };
    }

    var tray = box.parentNode.querySelector('.tray');
    if (tray) {
      /* ONE WORD FOR ONE PRESS. A held slot said REPLACE and every other
         slot said IMPORT for the same file chooser - Babe, 2026-10-26: "we
         might want to change the word REPLACE to IMPORT so its consistent".
         The selector keeps the old id so a tray that still says REPLACE
         anywhere keeps working rather than going quietly dead. */
      var imp = tray.querySelector('[data-act="import"], [data-act="replace"]');
      if (imp) imp.addEventListener('click', function () { picker.click(); });

      /* PRESET: something already in bg/, so the rung can be tried without
         handing over a face or shooting a performance. It is a real upload
         like any other, not a special case downstream.
         WHICH FILE IS THE SLOT'S OWN, from data-preset. It was one hard-coded
         face, which was fine while 01's source was the only slot offering
         this and wrong the moment 05's clip did too. */
      var pre = tray.querySelector('[data-act="preset"]');
      if (pre) pre.addEventListener('click', async function () {
        pre.disabled = true;
        var was = pre.textContent;
        pre.textContent = 'Loading';
        try {
          var t = face();
          var name = t.box.dataset.preset || box.dataset.preset;
          if (!name) throw new Error('this slot names no preset');
          var r = await fetch('/bg/' + name);
          if (!r.ok) throw new Error(name + ' is not in bg/');
          var blob = await r.blob();
          await putFile(t.box, new File([blob], name, { type: blob.type }), rung, t.key);
          /* after, because putFile clears the row on its way in */
          if (st(rung)[t.key]) {
            markAct(t.box, 'preset');
            st(rung).src = st(rung).src || {};
            st(rung).src[t.key] = 'preset';
            saveJourney();
          }
        } catch (err) {
          say(box.closest('.slide'), String(err.message || err), true);
        } finally {
          pre.disabled = false;
          pre.textContent = was;
        }
      });

      var cam = tray.querySelector('[data-act="webcam"]');
      if (cam) cam.addEventListener('click', function () { openCamFace(box, rung, key); });
      /* the face's own cell - the only one in the row while the camera is up */
      var camgo = tray.querySelector('.tr.camgo');
      /* THE FACE'S OWN CELL IS THE MIRROR NOW - Babe: "add flip where record
         is". Recording moved onto the strip, which left this cell free, and
         the flip is the one decision about the picture that is not a
         decision about the take. */
      if (camgo) camgo.addEventListener('click', function () {
        /* the cell is labelled from here because RECORD, CAPTURE or FLIP is a
           fact about the file chooser beside it, and it has to DO what it
           says: on a stills slot it is the shutter. */
        if (!wantsVideo(box)) return camAct(box, rung, key);
        box._flip = !box._flip;
        paintFlip(box);
      });
      /* and the two that decide about what it took */
      bindShot(box, rung, key);

      var rnd = tray.querySelector('[data-act="random"]');
      if (rnd) rnd.addEventListener('click', function () { roll(box, rnd, rung, key); });

      /* PROMPT turns the slot itself into the box you write in. Press it
         again to generate what you wrote; press it on an empty box, or hit
         Escape, and the slot goes back to how it was. */
      var ask = tray.querySelector('[data-act="prompt"]');
      if (ask) ask.addEventListener('click', function () {
        if (!box.classList.contains('is-ask')) return openAsk(box, ask);
        var field = box.querySelector('.ask');
        var text = field ? field.textContent.trim() : '';
        /* WHERE THIS BOX IS THE RUNG'S PROMPT there is nothing here to run,
           so the cell is only the way back - and what was written is kept,
           because closing a face you are working in does not mean discard. */
        if (box.closest('.slot').classList.contains('writes')) {
          return closeAsk(box, ask);
        }
        if (!text) return closeAsk(box, ask);
        /* the sentence stays on screen, greyed, with the scan running over
           it — you can read what you asked for while it is being made. */
        field.contentEditable = 'false';
        roll(box, ask, rung, key, text).then(function (ok) {
          if (ok) return exitAsk(box, ask);
          field.contentEditable = 'true';
        });
      });

      /* DESCRIBE turns the hero over to the card on its back. SAVE and the
         corner X both close it and both keep what is in the fields - SAVE is
         where writing the traits somewhere will go when there is somewhere to
         write them, which is the only reason it is a second button. */
      var desc = tray.querySelector('[data-act="describe"]');
      if (desc) desc.addEventListener('click', function () {
        openCard(box);
      });

      /* AUTO fills the card from the picture: Gemini looks at the hero and
         writes the nine fields, so they arrive as a draft to correct rather
         than a form to fill. The card stays editable and SAVE is still the
         person's word on it. */
      /* NO TOOLTIP ON A CELL THAT HAS A WORD ON IT - Babe, 2026-10-27,
         looking at "read these from the picture" hanging under AUTO: "im not
         a huge fan of this context menu hints", "idk if they are necessary".
         They are not. A native `title` is a second label the page cannot
         draw, cannot time and cannot style, and it was explaining a button
         that is already a word on a card headed TRAITS with the picture
         behind it. The glyph-only controls keep theirs, because there the
         tooltip is the only name the thing has. */
      var auto = tray.querySelector('[data-act="autotraits"]');
      if (auto) {
        auto.addEventListener('click', function () { readTraits(box.closest('.slide'), rung, auto); });
      }

      /* AND CLEAR IS THE ONLY WAY BACK TO AN EMPTY CARD. AUTO overwrites
         nothing - it fills what is blank - so a card holding somebody else's
         character could only be corrected a line at a time. It empties the
         five fields and writes that down, because a card you cleared and a
         card nobody has filled are the same card and a reload has to agree. */
      var wipe = tray.querySelector('[data-act="cleartraits"]');
      if (wipe) {
        wipe.addEventListener('click', function () {
          box.parentNode.querySelectorAll('.tf').forEach(function (f) {
            f.textContent = '';
          });
          var msg = box.parentNode.querySelector('.card-msg');
          if (msg) msg.textContent = '';
          saveJourney();
        });
      }

      var keep = tray.querySelector('[data-act="savetraits"]');
      if (keep) keep.addEventListener('click', function () { closeCard(box); });

    }

    /* THE SLOT'S OWN X, AND IT IS A DIRECT CHILD - the same thing its four
       CSS rules say. A box can hold a `.clr` of its own (the board's), and an
       unscoped query finds whichever comes first in the markup. */
    var x = box.parentNode.querySelector(':scope > .clr');
    if (x) x.addEventListener('click', function (e) {
      e.stopPropagation();
      /* AND IT THROWS AWAY THE FACE YOU ARE LOOKING AT - Babe, 2026-10-29,
         on 06's HERO with SCENE up: "i pressed x but the image did not
         remove", then "not getting an x to delete now". There is ONE X on a
         two-faced slot and this handler closed over the FRONT box, so the
         press emptied the face you could not see - and took `is-full` off
         the slot with it, which is why the X then vanished while the picture
         stayed. A box lying about what it holds, from the other side.
         `face()` is the reader every other action on this slot already uses
         - IMPORT, a dropped file, PRESET - and this was the one that did
         not ask. */
      var f = face();
      /* THE CARD'S BRANCH IS GONE WITH THE CARD'S X. While a face shows the X
         at all, that X is the way back rather than a way to throw the picture
         away - which is still true of the writing face below. The card hides
         it now and leaves by the header, so a branch for it here could only
         be code that cannot run. */
      var askCell = box.parentNode.querySelector('[data-act="prompt"]');
      if (f.box.classList.contains('is-ask') && askCell) return closeAsk(f.box, askCell);
      clearSlot(f.box, rung, f.key);
    });

    /* CLICKING A SLOT DOES NOT OPEN A FILE CHOOSER, ON ANY SLOT. It was a
       shortcut that cost more than it saved: it fired on the way to a
       double-click, it fired again when a click dismissed the big view onto
       the slot underneath, and it meant the box did two unrelated things
       depending on how fast you were. Every slot has IMPORT or REPLACE in its
       tray — the clip slot gained one with this change — and dropping a file
       on the box still works. Babe, 2026-10-24: "we need to remove the double
       click on slot to upload in general".

       SO THE BOX HAS ONE GESTURE: double-click for a bigger look. The result
       panel with nothing under it, nothing to decide, only the thing you are
       holding. Click away or press Escape to put it down. */
    /* AND ON AN EMPTY BOX THAT GESTURE IS FREE, SO IT IMPORTS - Babe,
       2026-10-29, having just done it to a bare HERO: "can we make it so you
       can double click on the empty slot to import as well? i just did that
       by instinct".
       IT DOES NOT RE-OPEN THE DOOR THAT WAS SHUT. What came off in October
       was the SINGLE click, because it fired on the way to a double-click
       and again when a click dismissed the big view onto the slot beneath,
       so the box did two unrelated things depending on how fast you were.
       A double-click on an EMPTY box collides with nothing: the one gesture
       this box has means "show me this bigger", and there is nothing to
       show - so the meaning is going spare rather than being shared.
       AND IT PRESSES THE TRAY CELL RATHER THAN THE PICKER, so a slot that
       does not offer IMPORT does not quietly grow it - 02's SHEET slot is a
       tray of four presets and must not open a file chooser - and so the
       face handling, the key and the provenance are the ones that cell
       already does. One mechanism, reached two ways.
       NOT WHILE THE BOX IS BEING WRITTEN IN: there the empty box is a
       sentence nobody has typed yet, not a picture nobody has brought. */
    box.addEventListener('dblclick', function (e) {
      var shown = box.querySelector('img, video');
      if (!shown) {
        if (box.classList.contains('is-ask')) return;
        var slot = box.closest('.slot');
        var imp = slot && slot.querySelector(
          '.tray .tr[data-act="import"], .tray .tr[data-act="replace"]');
        if (!imp) return;
        e.preventDefault();
        imp.click();
        return;
      }
      e.preventDefault();
      peek(box.closest('.slide'), shown.src, shown.tagName === 'VIDEO');
    });

    var cardEl = box.parentNode.querySelector('.card');
    if (cardEl) cardEl.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeCard(box);
    });
    picker.addEventListener('change', function () {
      var t = face();
      if (picker.files && picker.files[0]) putFile(t.box, picker.files[0], rung, t.key);
    });

    /* both faces take a dropped file and a double-click, and each one lands
       on its own key - the second face is a box like any other, not a
       picture of one. */
    [box, altBox].forEach(function (b) {
      if (!b) return;
      b.addEventListener('dragover', function (e) { e.preventDefault(); b.classList.add('is-busy'); });
      b.addEventListener('dragleave', function () { b.classList.remove('is-busy'); });
      b.addEventListener('drop', function (e) {
        e.preventDefault();
        b.classList.remove('is-busy');
        var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) putFile(b, f, rung, b === altBox ? altKey : key);
      });
      if (b === box) return;
      b.addEventListener('dblclick', function (e) {
        var shown = b.querySelector('img, video');
        if (!shown) return;
        e.preventDefault();
        peek(b.closest('.slide'), shown.src, shown.tagName === 'VIDEO');
      });
    });
  }

  /* ------------------------------------------------------------ the overlay */

  function overlayOf(slide) {
    var o = slide.querySelector('.runover');
    if (o) return o;
    o = document.createElement('div');
    o.className = 'runover';
    o.innerHTML =
      '<div class="runover-media"></div>' +
      '<div class="runover-msg"></div>' +
      /* WHAT IT IS, THEN WHAT YOU CAN DO - Babe, 2026-10-26: "lets change the
         order of these buttons. add IMAGE to the left with the aspect ratio
         text. then TRY AGAIN and CONTINUE JOURNEY". The strip reads left to
         right like every other tray on the rail, and it was reading the other
         way: two actions, and then, at the far end, what you were looking at.
         The thing comes first and the decision about it comes after. */
      '<div class="runover-foot"><span class="info"></span><div class="row" data-acts></div></div>';
    /* on the slide, not inside a plane: it centres on the stage and stays
       sharp while the planes behind it are blurred down. */
    slide.appendChild(o);
    return o;
  }

  /* A PYTHON EXCEPTION IS NOT A MESSAGE - Babe, 2026-10-27, looking at
     `SamplerCustomAdvanced #486: module 'os' has no attribute 'memfd_create'`
     on the panel: "should the message in the modal say something different
     when this happens?".

     THE ONE THING A PERSON NEEDS FROM A FAILURE IS WHOSE IT IS. Everything
     the server refuses by itself is already written for a person - `Your own
     shot needs ref1`, `nano is not wired`, `05 has not made anything yet` -
     and all of that goes through untouched, because it names something to do.
     A traceback out of a node names nothing anybody at this end can act on:
     that one is ComfyUI re-serialising a model's state dict into an anonymous
     memfd inside their own container, which no prompt, no seed and no graph
     we could write reaches from here.

     SO THE SHAPE IS THE TEST AND NOT THE WORDS IN IT. `errorText` on the
     server composes `<NodeType> #<id>: <message>` for exactly one case - an
     exception thrown while a job was executing - so that shape is the whole
     question, and an exception nobody has seen yet is covered the day it
     arrives. The raw line still goes to the console for whoever is debugging;
     what lands on the panel is what to do about it. Same split `niceError`
     already makes for the traits card, which calls this now rather than
     keeping a second opinion about the same sentence.

     AND IT LIVES IN `say` BECAUSE EVERY FAILURE ON THE RAIL ALREADY GOES
     THROUGH IT - the run, the board, the roll, the carry, the camera - so
     there is no site left to forget it, which a reader called at six call
     sites would be one edit away from being. */
  function plainly(m) {
    m = String(m || '');
    if (/^[A-Za-z0-9_]+(:[\w]+)? #[\w:]+: /.test(m)) {
      return 'it broke while running, not in anything you asked for '
           + '\u2014 try again'; /* (*) */
    }
    /* `failed` on its own is the state and not a reason: the detail endpoint
       had nothing in it to report. ByteDance answers exactly this way when a
       prompt describes a person, which is the one case worth not dressing up
       as something a second press will fix. */
    if (/^(failed|error|non_retryable_error|lost)$/i.test(m)) {
      return 'the job failed and gave no reason \u2014 try again'; /* (*) */
    }
    return m;
  }

  /* A REFUSAL THAT NAMES A SLOT POINTS AT THE SLOT, NOT AT THE RAIL - Babe,
     2026-10-27, with EDIT THE PICTURE NEEDS SOURCE over a blurred stage:
     "this message should prob not appear as a modal". THE RESULT PANEL IS
     FOR A THING YOU CAN ACT ON - a picture, or a failure that happened to
     one - and this is neither: nothing ran, nothing was spent, and the whole
     answer is which box is empty. Covering the rail to say so hides the one
     thing a person has to go and look at. (The settled rule that failures
     stay in the modal is about a job that FAILED; this is a press that never
     became a job.)
     THE SHAPE IS THE TEST, NOT THE WORDS IN IT, which is how `errorText`
     tells a node exception from a sentence written for a person. Every
     rung's missing-input refusal is `<label> needs <key>` and the key is
     the input's own name, so a rung added next month is pointed at too, and
     anything else still opens the panel because anything else is about a job
     that ran. */
  var NEEDS = /\bneeds ([a-z0-9_]+)\.?$/i;
  /* AND THE KEY NAMES A SIDE WHERE THE SLOT TABLE DOES NOT. 04's left slot
     is `figure` to the server and `start` to the journey and has been since
     the renumbering, so the table answers first and this is the fallback -
     one line the day a key moves house, rather than a second slot table. */
  var WANT_SIDE = { source: 'left', figure: 'left', start: 'left', board: 'left',
                    ref1: 'left', sheet: 'alt', ref: 'right', place: 'right',
                    clip: 'right' };

  function wantSlot(slide, text) {
    var hit = NEEDS.exec(String(text || ''));
    if (!hit) return false;
    var key = hit[1].toLowerCase();
    var map = SLOTS[rungOf(slide)] || {};
    var side = key === map.left ? 'left'
             : key === map.right ? 'right'
             : key === map.alt ? 'alt'
             : WANT_SIDE[key];
    var boxes = boxesOf(slide);
    var box = side === 'right' ? boxes.front[1]
            : side === 'alt' ? (boxes.alt[0] || boxes.alt[1])
            : side === 'left' ? boxes.front[0]
            : null;
    var slot = box && box.closest('.slot');
    /* a key nothing on this slide answers to is a refusal with nowhere to
       point, and that one still deserves the panel. */
    if (!slot) return false;
    console.warn('run:', String(text));
    slot.classList.add('is-want');
    clearTimeout(slot._want);
    slot._want = setTimeout(function () { slot.classList.remove('is-want'); }, 2600);
    /* AND THE WORDS HANG UNDER THE PROGRESS BAR, NOT ON RUN - Babe,
       2026-10-29: "i would rather that show somewhere else tho maybe on the
       left below the progress bar". Run said it because Run is the cell that
       speaks for a run, and that argument held for as long as the message
       was about the press. It is not: it is about something to go and do
       somewhere else on the screen, and a button that stops saying RUN has
       stopped being a button while it says something else.
       AND IT SAYS THE PAGE'S OWN WORD FOR THE FACE, NOT THE INPUT'S KEY.
       `NEEDS REF1` named a node address at somebody who can only see a slot
       called CHARACTER - and on a two-faced slot it named neither face, so a
       slot with a picture in it was marked red for being empty. The cell
       that names the face is the one thing that cannot be out of step with
       what is drawn, so the word is read off it and the cell is marked too:
       the red edge says which slot, the lit cell says which FACE. */
    var pick = null;
    var picks = slot.querySelectorAll('.tray .pick');
    for (var pi = 0; pi < picks.length; pi++) {
      if ((picks[pi].dataset.f || '0') === (side === 'alt' ? '1' : '0')) pick = picks[pi];
    }
    var word = (pick && pick.textContent.trim()) || slot.dataset.face0 || key;
    if (pick) {
      pick.classList.add('is-want');
      clearTimeout(pick._want);
      pick._want = setTimeout(function () { pick.classList.remove('is-want'); }, 2600);
    }
    /* (*) `Needs <face>` is mine. */
    var line = slide.querySelector('.mid-col .wantline');
    if (line) {
      line.innerHTML = '<b>Needs ' + word + '</b>';
      clearTimeout(line._want);
      line._want = setTimeout(function () { line.innerHTML = ''; }, 2600);
    }
    return true;
  }

  function say(slide, text, bad) {
    if (bad && wantSlot(slide, text)) return;
    var o = overlayOf(slide);
    o.classList.add('is-on');
    var m = o.querySelector('.runover-msg');
    if (bad && text) console.warn('run:', String(text));
    m.textContent = bad ? plainly(text) : text;
    m.classList.toggle('bad', !!bad);
  }

  /* ---------------------------------------------------------- every shot
     THE RAIL ONLY EVER SHOWS THE LATEST. Each section stands in the room it
     made, which is a gallery of a sort, but a reroll replaces the one before
     it and there was nowhere to get back to. Babe, 2026-10-25: "there's no
     like assets / output to see your session generations... should there be
     an icon somewhere that opens a modal / gallery viewers sort of thing?"

     IT REUSES THREE THINGS RATHER THAN INVENTING A FOURTH. The result
     overlay already dims and blurs every plane across the rail, sizes itself
     to its content and closes on an outside click or Escape. The strip is
     the slot tray's construction. And stepping from the strip into one shot
     is the nested panel 04's DIRECTION and 05's SCENE already use, chevron
     and all - so there is nothing new to learn here.

     AND IT COSTS NO SERVER WORK: /api/output already returns every path
     newest-first, and the path carries everything the strip needs to say -
     output/2026-10-25/05-your-own-shot/161521-seedance-2-5-1452100706.mp4 is
     a day, a section, a time, a model and a seed. */
  /* output/<session>/<NN>/<HHMMSS-model-seed>.<ext> - the structure Babe
     asked for, 2026-10-25: "maybe just do output/session01/01/", "so its
     simple". The date left the path with the day folder, so it comes back
     from the listing instead and is looked up by session. */
  var OUT_DAYS = {};
  /* THE SITTING, SAID THE WAY THE URL SAYS IT. `session03` is what you type
     to go back to one, so the row says SESSION 03 rather than inventing a
     friendlier name nothing else on the rail would answer to. The day comes
     from the listing, which carries what the path cannot. */
  function sessionRow(info) {
    var el = document.createElement('div');
    el.className = 'shots-div';
    el.dataset.session = info.session || '';
    var n = (String(info.session).match(/(\d+)$/) || [])[1];
    /* THE LABEL IS ONE CHILD AND THE X IS THE OTHER, so the row can put them
       at opposite ends without the date becoming a flex item of its own. */
    var k = document.createElement('span');
    k.innerHTML = '<b>' + (n ? 'Session ' + n : (info.session || 'Older')) + '</b>' +
                  (info.day ? ' &middot; ' + info.day : '');
    el.appendChild(k);
    var x = document.createElement('button');
    x.className = 'x';
    x.type = 'button';
    x.setAttribute('aria-label', 'Put this session away');
    x.textContent = '×';
    el.appendChild(x);
    return el;
  }

  /* AND A TILE ASKS FOR ITS FILE WHEN IT IS NEARLY IN VIEW. The root is the
     grid itself because that is what scrolls; 500px of margin means the
     pictures are already there by the time you reach them, and a browser
     with no IntersectionObserver gets the lot at once rather than nothing. */
  function watchTiles(grid) {
    var load = function (el) {
      if (!el || !el.dataset.src) return;
      el.src = el.dataset.src;
      delete el.dataset.src;
    };
    var all = grid.querySelectorAll('.shot img[data-src], .shot video[data-src]');
    if (!window.IntersectionObserver) {
      return all.forEach(load);
    }
    var eye = new IntersectionObserver(function (rows) {
      rows.forEach(function (row) {
        if (!row.isIntersecting) return;
        load(row.target);
        eye.unobserve(row.target);
      });
    }, { root: grid, rootMargin: '500px 0px' });
    all.forEach(function (el) { eye.observe(el); });
  }

  function shotInfo(path) {
    var bits = path.split('/');
    var file = bits[bits.length - 1] || '';
    var folder = bits[bits.length - 2] || '';
    var session = bits[bits.length - 3] || '';
    var t = (file.match(/^(\d{2})(\d{2})(\d{2})/) || []).slice(1);
    return {
      path: path,
      /* the folder is "05-your-own-shot"; the number is the only part worth
         showing at 132px, and the rest of it is not a word this UI says. */
      rung: /^\d+$/.test(folder) ? folder : '',
      session: session,
      day: OUT_DAYS[session] || '',
      time: t.length === 3 ? t[0] + ':' + t[1] : '',
      vid: /\.(mp4|webm)$/i.test(file)
    };
  }

  /* PUT AWAY, NOT DESTROYED. Babe's words were "delete them from the
     session", and the session is the right scope: output/ is the only copy
     of every one of these and some of them cost real money, so a press in a
     browsing panel must not be the thing that ends one. The file stays where
     it is and the panel stops showing it.
     IT OUTLIVES A RELOAD, because a prune you have to redo every time you
     open the page is not a prune. Same storage rules as the dock side and
     the collapsed knobs: guarded everywhere, and never in Copy values.
     HJ.unhide() brings them all back, which is the undo until the panel has
     somewhere to put one. */
  var HIDDEN_KEY = 'hj-hidden';
  /* AND A WHOLE SITTING CAN GO, WHICH IS THE SAME VERB ONE LEVEL UP. Babe,
     2026-10-28, wanting to film the panel: "there are sessions i want to
     remove maybe we can add an x on them to remove the entire session from
     view?", then which ones - "i want to remove 09 08 and 04 from view", "so
     only 03 is after the new 13".
     IT IS A SECOND KEY RATHER THAN A PATH IN THE FIRST, because they are two
     different facts: a file put away is a select, and a sitting put away is a
     drawer closed - and a sitting that gets a new file tomorrow should stay
     closed, which a list of paths cannot say. `HJ.unhide()` empties both. */
  var HIDDEN_SESSIONS = 'hj-hidden-sessions';
  function hiddenSet() {
    try { return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]') || []); }
    catch (e) { return new Set(); }
  }
  function hiddenSessions() {
    try { return new Set(JSON.parse(localStorage.getItem(HIDDEN_SESSIONS) || '[]') || []); }
    catch (e) { return new Set(); }
  }
  function hideSession(name) {
    var set = hiddenSessions();
    set.add(name);
    try { localStorage.setItem(HIDDEN_SESSIONS, JSON.stringify(Array.from(set))); }
    catch (e) { /* a panel that cannot remember still has to work */ }
  }
  window.HJ.hideSession = hideSession;
  function hideShot(path) {
    var set = hiddenSet();
    set.add(path);
    /* Array.from, NOT [].slice.call. A Set is iterable but not array-like -
       it has no length - so slice walked nothing and wrote [] every time.
       It failed silently and looked exactly like a storage that was being
       written: the tile went, and came back on the next open. */
    try { localStorage.setItem(HIDDEN_KEY, JSON.stringify(Array.from(set))); }
    catch (e) { /* a panel that cannot remember still has to work */ }
  }

  function shotCell(info) {
    var b = document.createElement('button');
    b.className = 'shot' + (info.vid ? ' is-vid' : '');
    b.dataset.path = info.path;
    b.dataset.vid = info.vid ? '1' : '';
    /* THE TILE SAID ITS OWN DATE ON HOVER AND THE FOOT SAYS IT ON SELECT.
       One of those is a tooltip and the other is the panel doing its job. */
    b.setAttribute('aria-label', info.day + ' ' + info.time + '  ' + info.label);
    /* AND IT IS ALWAYS AN IMG, because the tile asks the server for a 320px
       JPEG rather than for the file itself - a clip's thumbnail is its first
       frame, made once by ffmpeg and cached, so the grid stops loading twenty
       videos to show twenty stills. A tile-sized picture also decodes inside
       a frame, which is what lets the reveal be a build rather than a race
       between the easing and the decoder. */
    var m = document.createElement('img');
    /* NOTHING LOADS UNTIL IT IS NEARLY ON SCREEN - Babe, 2026-10-26: "we
       should have a smart loading thing tho so this loads fast". The panel
       shows every file in output/, so opening it used to ask for every one
       of them at once - a hundred full-size pictures to draw a hundred
       tiles 270px wide. The src waits on `data-src` and an observer hands
       it over a few hundred pixels before the tile arrives, which is also
       why the grid can stay honest about showing everything.
       `loading=lazy` is kept as the backstop for the images, because an
       observer that never fires is a wall of empty boxes. */
    m.dataset.src = '/api/thumb?path=' + encodeURIComponent(info.path);
    /* and both kinds are the same element now, so both get the same two
       hints - the clip's `preload` went with the <video> it was written for. */
    m.loading = 'lazy';
    m.decoding = 'async';
    b.appendChild(m);
    /* NO NUMBER ON THE TILE - Babe, 2026-10-25: "we can remove the numbers
       from them". It was there when the band had no view beside it and a
       thumbnail had to carry its own identity; the line under the picture
       names the section now, so the corner was saying it twice. */
    /* THE SAME X, IN THE SAME CORNER, MEANING THE SAME THING - "can we make
       x icons on the top right of each one to delete them from the session",
       "like we are making selects", "right. not delete from disk". Every
       slot on the rail already has one tucked into its top-right, so this is
       a verb the page has already taught. */
    var x = document.createElement('button');
    x.className = 'x';
    x.type = 'button';
    x.setAttribute('aria-label', 'Put this shot away');
    x.textContent = '×';
    b.appendChild(x);
    return b;
  }

  async function shots(slide) {
    slide = slide || window.HJ.slides[window.HJ.index()];
    var o = overlayOf(slide);
    o.classList.add('is-on', 'is-shots');
    o.classList.remove('is-peek', 'has-back', 'is-key');
    /* A BUTTON THAT OPENS SOMETHING STAYS DOWN WHILE IT IS OPEN - Babe,
       2026-10-25: "when you press the media icon can you keep it toggled on
       / highlight". closeResult puts it back up, which is the only other
       place this panel's state changes. */
    var trigger = document.getElementById('shots');
    if (trigger) trigger.setAttribute('aria-pressed', 'true');
    o.querySelector('.runover-msg').textContent = '';
    var media = o.querySelector('.runover-media');
    media.innerHTML = '';
    var info = o.querySelector('.info');
    info.textContent = 'reading output…';
    acts(slide, []);

    var files = [];
    try {
      var r = await fetch('/api/output');
      var j = await r.json();
      files = (j && j.files) || [];
      OUT_DAYS = (j && j.days) || {};
    } catch (err) { /* reported below */ }

    if (!files.length) {
      media.innerHTML = '';
      info.textContent = 'nothing made yet';
      return;
    }
    /* TWO HALVES: the grid chooses, the view shows. The band tried to do
       both in one row of thumbnails, which is what "unorganized" was -
       browsing wants many things small and viewing wants one thing big. */
    var body = document.createElement('div');
    body.className = 'shots-body';
    var grid = document.createElement('div');
    grid.className = 'shots-grid';
    var gone = hiddenSet();
    var goneSessions = hiddenSessions();
    files = files.filter(function (p) {
      return !gone.has(p) && !goneSessions.has(shotInfo(p).session);
    });
    /* A LINE BETWEEN SITTINGS. The listing is newest first and the session
       is in the path, so a group ends where the name changes - no sorting,
       no second list, and a file that moves folders brings its own answer
       with it. */
    var seen = null;
    files.forEach(function (p) {
      var info = shotInfo(p);
      if (info.session !== seen) {
        seen = info.session;
        grid.appendChild(sessionRow(info));
      }
      grid.appendChild(shotCell(info));
    });
    watchTiles(grid);
    /* EACH COLUMN IS A BOX AND A ROW WELDED TO IT, which is the slot's own
       construction - Babe, 2026-10-25: "i kind of want to... have it appear
       in a row at the bottom of the grid", "would rather add a few buttons
       to the bottom right below the media". So the facts belong to the grid
       you picked from and the actions belong to the picture you are looking
       at, and neither row is floating under something it is not about. */
    var left = document.createElement('div');
    left.className = 'shots-left';
    left.appendChild(grid);
    left.insertAdjacentHTML('beforeend', '<div class="shots-line"></div>');
    var view = document.createElement('div');
    view.className = 'shots-view';
    view.innerHTML = '<div class="shots-head"></div>' +
                     '<div class="shots-stage"></div><div class="shots-acts"></div>';
    body.appendChild(left);
    body.appendChild(view);
    media.appendChild(body);

    /* it opens on the newest, because a panel that opens on nothing makes
       you do the one thing it was built to save you. */
    var firstCell = grid.querySelector('.shot');
    if (firstCell) showShot(o, firstCell);

    /* AND THE GRID ARRIVES RATHER THAN BEING THERE. Babe, 2026-10-28:
       "i am curious if its possible to cascade the thumbnails in the grid".
       It is `HJ.cascade`, the opening's own move lent out - the same one the
       traits card uses - and the discipline is the part worth borrowing: the
       targets are hidden in the same task that builds them, so the finished
       grid is never painted on the way in, and every tile gets back the
       inline style it arrived with.
       ONLY THE FIRST SCREENFUL. There are fifty-odd tiles in here and a 55ms
       stagger across all of them is three seconds of a panel assembling
       itself, which is a wait rather than an arrival - and the ones below
       the fold have not loaded their pictures yet, because the observer
       hands those over 500px out. Sixteen at 26ms is the top of the grid
       landing in under half a second, and everything after it is scrolled
       to rather than watched. */
    /* THE PANEL BUILDS, THE WAY THE PAGE DOES. Babe, 2026-10-28: "theres no
       real build to this page", "it feels random the big video shows first
       and then the other thumbnails still fade in random", "we can basically
       use the same similar animejs we use on the main ui intro". So it is
       `HJ.cascade` three times with an offset between them, which is exactly
       what `intro` is - groups in a chosen order rather than one list - and
       the order is the panel's own sentence: the grid you choose from, then
       the picture it chose, then the two rows that talk about it.
       NOTHING ARRIVES BEFORE ITS PICTURE. The tiles ask for 320px thumbnails
       now, so waiting for them is a frame or two rather than a held breath -
       but it is still a wait, because opacity is all a cascade can animate
       and a tile that decodes late paints late however it was eased.
       AND THE ROWS BELOW THE FOLD ARE HELD, not cascaded: a fixed count was a
       guess at what is on screen, and the rows past it sat at full opacity
       from the first frame while the top faded in. The grid is asked how tall
       it is instead, and everything below simply appears when the build is
       done, because nobody watches it arrive. */
    var rows = [].slice.call(grid.children);
    var later = [ left.querySelector('.shots-line'),
                  view.querySelector('.shots-head'),
                  view.querySelector('.shots-stage'),
                  view.querySelector('.shots-acts') ].filter(Boolean);
    rows.concat(later).forEach(function (el) { el.style.opacity = 0; });
    /* AND WHICH ROWS ARE VISIBLE IS MEASURED AGAINST THE GRID'S OWN RECT, not
       by offsetTop: a tile is a <button> and its offsetParent is whatever is
       positioned above it, not the grid, so every tile reported an offset past
       the fold, nothing was cascaded, and the whole grid was released at once.
       Babe, 2026-10-28: "it looks like it all just fades on at the same time".
       A rect is relative to the viewport and cannot be fooled by a parent that
       happens not to be positioned. */
    var fold = grid.clientHeight || 640;
    var top = grid.getBoundingClientRect().top;
    var seen = rows.filter(function (row) {
      return row.getBoundingClientRect().top - top < fold;
    });
    var rest = rows.filter(function (row) { return seen.indexOf(row) < 0; });
    var eager = [];
    seen.forEach(function (row) {
      [].slice.call(row.querySelectorAll('img[data-src]')).forEach(function (el) {
        el.src = el.dataset.src;
        delete el.dataset.src;
        eager.push(new Promise(function (go) {
          if (el.complete) return go();
          el.addEventListener('load', go, { once: true });
          el.addEventListener('error', go, { once: true });
        }));
      });
    });
    var show = function (els) { els.forEach(function (el) { el.style.opacity = ''; }); };
    Promise.race([
      Promise.all(eager),
      new Promise(function (go) { setTimeout(go, 700); })
    ]).then(function () {
      if (!o.classList.contains('is-shots')) return;
      if (!window.HJ || !window.HJ.cascade) { show(rows.concat(later, rest)); return; }
      show(seen); show(later);          /* cascade reads each one's resting value */
      var gridFor = 48 * seen.length + 320;
      window.HJ.cascade(seen,   { stagger: 48, rise: 10, duration: 380 });
      window.HJ.cascade(later,  { stagger: 90, rise: 12, duration: 460, start: gridFor });
      setTimeout(function () { show(rest); }, gridFor);
    });
  }

  /* THE GRID CHOOSES AND THE VIEW SHOWS, so a press is a selection and
     nothing else. In the band a press had to compete with a drag, which is
     why opening was a double-click; side by side there is nothing to compete
     with, and a single press is the plainest thing a tile can do. There is
     no step in here and so no step back, which is most of why this shape is
     less to think about than the band was. */
  /* BACK INTO THE WORKFLOW THAT MADE IT - Babe, 2026-10-25: "would rather
     add a few buttons to the bottom right below the media for options like
     EDIT - EXTEND - which take you to that workflow to run again".
     THESE ARE 05's OWN MODES, so the button is not a new idea, it is the
     mode tab reached from somewhere else: it puts the clip in TRANSFER
     MOTION, presses that tab, travels to 05 and closes the panel. The next
     press of RUN is the run.
     IT MARKS THE BOX THE WAY fill() DOES - `data-fromFile` and nothing
     uploaded - so the file goes to Comfy on the way out of RUN and what you
     are looking at is what gets sent, which is the rule this rail keeps
     having to re-learn.
     ONLY A CLIP GETS THEM. Edit and extend are things you do to footage;
     a still has no workflow of its own to be sent back into yet. */
  /* A STILL GOES BACK TO 01 AND A CLIP GOES BACK TO 05 - Babe, 2026-10-25:
     "can you make edit now take you back to the 01 workflow". Which rung a
     shot can be sent back into is decided by what it IS, not by which button
     you pressed: 05 edits and extends footage, and 01 is the rung that takes
     a picture and makes something of it.
     AND ON 01 IT IS THE SOURCE, NOT THE REFERENCE - Babe: "maybe the correct
     workflow is to load it into the source and have prompt selected". Which
     is right, and the first version had it in the right-hand slot on a
     left-is-inherited argument that does not apply here: for an EDIT the
     picture is the subject, and SOURCE is exactly what 01 calls the subject.
     The right-hand slot is then free to be what it should be - the sentence
     saying what to change - so the PROMPT face opens with it.
     ON 05 IT IS STILL front[1], because there the clip is the performance
     being transferred and the left slot is the character it is transferred
     onto. Same rule read correctly in both places: the shot goes where its
     own role lives. */
  function sendTo(mode, path, vid) {
    /* 06 is the rung that edits and extends footage; 05 makes a clip from a
       board and has nothing to send one back into. */
    var at = vid ? 5 : 0;
    var slide = window.HJ.slides[at];
    if (!slide) return;
    var pair = boxesOf(slide);
    var box = vid ? pair.front[1] : pair.front[0];
    if (box) {
      /* marked, not uploaded: the run sends it on the way out, which is how
         fill() does it and why what you are looking at is what gets sent. */
      box.dataset.fromFile = path;
      showMedia(box, '/' + path, vid);
      st(at + 1)[vid ? 'clip' : 'source'] = '';
      markAct(box, '');
    }
    /* PRESSED, NOT SET. The strip's own handler is what writes the slot's
       mode, its `writes` class and the prompt line, so setting the
       attributes by hand left the rung wearing the other mode's line and a
       writing face that still thought it was a generator. */
    var slot = slide.querySelector('.slot[data-mode]');
    var want = slot && slot.querySelector('.ftab[data-mode="' + mode + '"]');
    if (want) want.click();
    else if (slot) slot.dataset.mode = mode;
    /* and the sentence is the thing left to write, so the box that takes one
       is already open when you arrive. The tray cell is the one path into
       that face, so it is pressed rather than re-implemented. */
    if (!vid) {
      var askCell = slide.querySelector('.inp:last-child .tray .tr[data-act="prompt"]');
      var asking = slide.querySelector('.slot.is-asking');
      if (askCell && !asking) askCell.click();
    }
    closeResult();
    window.HJ.go(at);
  }

  function showShot(panel, cell) {
    var info0 = shotInfo(cell.dataset.path);
    var stage = panel.querySelector('.shots-stage');
    var line = panel.querySelector('.shots-line');
    var head = panel.querySelector('.shots-head');
    if (!stage) return;
    panel.querySelectorAll('.shot').forEach(function (c) {
      c.setAttribute('aria-pressed', String(c === cell));
    });
    /* whatever was playing stops, for the same reason closing the panel
       stops it: a hidden video is still a video. */
    stage.querySelectorAll('video').forEach(function (v) { v.pause(); });
    stage.innerHTML = '';
    var vid = cell.dataset.vid === '1';
    var el = document.createElement(vid ? 'video' : 'img');
    el.src = '/' + cell.dataset.path;
    /* AND IT DOES NOT START ITSELF - Babe, 2026-10-29: "can we turn off the
       autoplay from when you open the media library".
       THIS PANEL IS FOR BROWSING AND THE RESULT PANEL IS FOR JUDGING. A clip
       that plays the moment you open a drawer takes the room's attention and
       its sound, and the grid beside it is the thing you are actually reading
       - so the viewer loads the first frame and waits. The result panel keeps
       its autoplay, where a clip IS the answer you just asked for.
       (*) `library.json` IS SHOT WITH IT ON. If that take is ever re-filmed,
       it needs a press on the transport where it used to need none. */
    if (vid) { el.controls = true; el.loop = true; el.playsInline = true; }
    stage.appendChild(el);

    /* WHICH WORKFLOW MADE IT, OVER THE PICTURE IT MADE - Babe, 2026-10-25:
       "for the header on the right column tho maybe we do show the workflow
       number that created it", "like 01 BECOME SOMEONE". It belongs to the
       shot rather than to the row of file facts: the facts are what the file
       is, and this is where it came from.
       IT IS THE NAV'S OWN WORDS, read off the button rather than kept as a
       second list of section names that could drift from the one across the
       top of the page. A roll has no section, so the header is empty and
       does not draw. */
    if (head) {
      var tab = info0.rung
        ? [].find.call(document.querySelectorAll('.nav .ck'),
            function (b) { return b.textContent.trim().indexOf(info0.rung) === 0; })
        : null;
      /* the nav sets the number off from the name with two spaces and uses
         one inside the name, so collapsing everything to two put a gap in
         the middle of KEEP MOVING. Only the first run is the separator. */
      head.textContent = tab
        ? tab.textContent.trim().replace(/\s+/g, ' ').replace(/ /, '  ')
        : '';
    }

    /* THE SHAPE ARRIVES WITH THE PICTURE, not with the path, so the ratio is
       written in once the media knows its own size. Until then it is absent
       rather than wrong. */
    var setRatio = function () {
      /* ONLY IF THIS IS STILL THE PICTURE ON STAGE. Every selection makes a
         new element and leaves the old one to be collected - but a discarded
         element's `load` still fires, and it was writing its ratio into the
         line belonging to whatever you had clicked since. Three different
         shots all reported 16:9 because the sheet's listener landed last. */
      if (el.parentNode !== stage) return;
      var w = el.naturalWidth || el.videoWidth, h = el.naturalHeight || el.videoHeight;
      if (!w || !h || !line) return;
      var cell2 = line.querySelector('[data-k="ratio"]');
      if (!cell2) return;
      /* the key goes back in with the value: textContent on the span would
         take the <i> with it, and a value with no name is a number nobody
         can read. */
      cell2.innerHTML = '';
      var rk = document.createElement('i');
      rk.textContent = 'ratio';
      cell2.appendChild(rk);
      cell2.appendChild(document.createTextNode(ratioName(w / h)));
    };
    el.addEventListener(vid ? 'loadedmetadata' : 'load', setRatio);
    /* and once now, because a cached picture may already know its size and
       will never fire the event we just subscribed to. */
    setRatio();

    if (!line) return;

    /* WHAT THE PATH ALREADY KNEW. The section, the day, the time, the model
       and the seed are all in the name, so this line is read rather than
       recorded: 161521-seedance-2-5-1452100706.mp4 */
    /* the row under the picture follows the picture */
    var acts = panel.querySelector('.shots-acts');
    if (acts) {
      acts.innerHTML = '';
      /* THE BAR STAYS FOR A STILL TOO - Babe, 2026-10-25: "can we leave the
         bar for images as well and give the option to edit, we may make a
         tab for that in section 01". A row that disappears under half the
         things you click is a layout that moves while you browse, which is
         the opposite of what a review panel is for.
         EDIT IS DRAWN AND DISABLED ON A STILL, because the tab it would send
         you to does not exist yet. A control that does nothing is worse than
         no control - but one that is visibly not available yet is a
         different thing from one that lies, and `.tr[disabled]` already dims
         its text rather than fading the divider it carries. The day 01 grows
         that tab, this is one line and the row does not move. */
      (vid ? ['EDIT', 'EXTEND'] : ['EDIT']).forEach(function (mode) {
        var btn = document.createElement('button');
        btn.className = 'tr';
        btn.type = 'button';
        btn.textContent = mode;
        /* EDIT IS LIVE ON A STILL NOW that 01 has a tab to land on, so
           neither button is drawn only to be refused. */
        btn.addEventListener('click', function () {
          sendTo(mode, cell.dataset.path, vid);
        });
        acts.appendChild(btn);
      });
    }

    var i = info0;
    var file = cell.dataset.path.split('/').pop();
    var tail = file.replace(/^\d{6}-/, '').replace(/\.[a-z0-9]+$/i, '');
    var seed = (tail.match(/-(\d{4,})$/) || [])[1] || '';
    var model = seed ? tail.slice(0, -(seed.length + 1)) : tail;
    line.innerHTML = '';
    /* FOUR FACTS, AND THEY ARE FACTS ABOUT THE FILE - Babe, 2026-10-25: "i
       wonder if thats still confusing or overkill. maybe we just show the
       filename. date. aspect ratio. and model that created it".
       SECTION, SESSION AND SEED WENT. The first two are where it lives, and
       you just clicked it out of a grid that is grouped that way, so the row
       was telling you how you got here. The seed is in the filename anyway -
       everything the name already says, the row was saying again beside it.
       WHAT THE NAME CANNOT SAY IS THE SHAPE, which is why the ratio earns
       the place they left: it is the one fact about a picture you cannot
       read off a path, and on this rung especially - a sheet is 16:9, a
       character is 1:1, a clip is whatever the source was. It arrives when
       the media loads, so it is written in below rather than here. */
    [['file', file],
     ['made', (i.day || '') + (i.time ? '  ' + i.time : '')],
     ['ratio', ''],
     ['model', model.replace(/-/g, ' ')]].forEach(function (p) {
      /* the ratio draws empty and is filled the moment the media loads */
      if (!p[1] && p[0] !== 'ratio') return;
      var span = document.createElement('span');
      span.dataset.k = p[0];
      var k = document.createElement('i');
      k.textContent = p[0];
      span.appendChild(k);
      span.appendChild(document.createTextNode(p[1]));
      line.appendChild(span);
    });
  }

  document.addEventListener('click', function (e) {
    /* A SITTING GOES THE WAY A SHOT DOES: the row it is on and every tile
       under it, down to the next divider. Walking forward from the divider
       is the same answer the drawing already gives - the grid IS in session
       order, because a group ends where the name changes. */
    var sx = e.target.closest && e.target.closest('.shots-div .x');
    if (sx) {
      e.stopPropagation();
      e.preventDefault();
      var row = sx.closest('.shots-div');
      var panel0 = row.closest('.runover');
      hideSession(row.dataset.session);
      var showing = false;
      var n = row.nextElementSibling;
      while (n && !n.classList.contains('shots-div')) {
        var after = n.nextElementSibling;
        if (n.getAttribute('aria-pressed') === 'true') showing = true;
        n.remove();
        n = after;
      }
      row.remove();
      /* the view follows the same rule the tile's X follows: it moves to
         whatever is left rather than going blank. */
      if (showing && panel0) {
        var first = panel0.querySelector('.shot');
        if (first) showShot(panel0, first);
        else {
          var st0 = panel0.querySelector('.shots-stage');
          var ln0 = panel0.querySelector('.shots-line');
          if (st0) { st0.querySelectorAll('video').forEach(function (v) { v.pause(); }); st0.innerHTML = ''; }
          if (ln0) ln0.innerHTML = '';
        }
      }
      return;
    }
    var x = e.target.closest && e.target.closest('.shot .x');
    if (x) {
      /* the X is inside the tile, so the tile's own press has to be stopped
         or putting one away would also select it on the way out. */
      e.stopPropagation();
      e.preventDefault();
      var cell = x.closest('.shot');
      var panel = cell.closest('.runover');
      var was = cell.getAttribute('aria-pressed') === 'true';
      hideShot(cell.dataset.path);
      var next = cell.nextElementSibling || cell.previousElementSibling;
      cell.remove();
      /* if it was the one on show, the view moves to its neighbour rather
         than going blank - an empty stage reads as something broken. */
      if (was && next) showShot(panel, next);
      else if (was) {
        var stage = panel.querySelector('.shots-stage');
        var line = panel.querySelector('.shots-line');
        stage.querySelectorAll('video').forEach(function (v) { v.pause(); });
        stage.innerHTML = '';
        if (line) line.innerHTML = '';
      }
      return;
    }
    var cell2 = e.target.closest && e.target.closest('.shot');
    if (!cell2) return;
    var panel2 = cell2.closest('.runover');
    if (panel2) showShot(panel2, cell2);
  });

  /* the overlay, used as a magnifying glass rather than as a result */
  /* A PANEL THAT OPENS BEFORE ITS PICTURE IS A PANEL WITH NOTHING IN IT.
     Babe, 2026-10-26, with a screenshot of the foot strip alone on a blurred
     rail: "can we remove this thing that appears before the modal popup". The
     overlay was put on screen and the file was asked for afterwards, so the
     first thing a finished run showed you was TRY AGAIN and CONTINUE JOURNEY
     over an empty box, with the info cell blank because there was nothing
     loaded to measure. THE RESULT BOX SIZES TO THE PICTURE, so the panel then
     grew under the buttons as the image landed.

     IT IS NOT A DELAY, IT IS THE ORDER. The element is made, pointed at the
     file and waited on BEFORE `is-on` goes near the panel, so the panel's own
     arrival is the first thing seen and what arrives is already complete -
     picture, ratio and buttons.

     AND IT ALWAYS RESOLVES. An error resolves it as well as a load, because a
     file that will not decode still needs its panel: that is where the
     message is. The cap is the same argument for a file that is neither -
     six seconds of a proxied download is longer than this has ever taken, and
     an empty panel beats no panel at all. */
  function ready(el) {
    var vid = el.tagName === 'VIDEO';
    if (vid ? el.readyState >= 1 : el.complete) return Promise.resolve();
    return new Promise(function (done) {
      var over = false;
      function fin() { if (over) return; over = true; done(); }
      el.addEventListener(vid ? 'loadedmetadata' : 'load', fin);
      el.addEventListener('error', fin);
      setTimeout(fin, 6000);
    });
  }

  /* WHAT A URL IS A FILE OF. A peek is handed a src rather than a result, and
     a proxied one carries the real name in its query - `/api/file?filename=…`
     - where the path's last segment is `file` and tells nobody anything. */
  function fileFromSrc(src) {
    var name = '';
    try { name = new URL(src, location.href).searchParams.get('filename') || ''; }
    catch (err) { /* a data: URL has no query */ }
    if (!name) name = String(src).split('?')[0].split('/').pop() || '';
    return { filename: name, url: src };
  }

  /* A BIGGER LOOK IS A LOOK, AND IT STILL SAYS WHAT IT IS - Babe, 2026-10-26:
     "i think opening them full screen we may need the other modal too just
     not the continue journey", "but to be able to save and view metadata is
     nice". The foot was hidden outright on the argument that there is nothing
     to decide here, which is true of the DECISIONS and not of the strip: what
     it came back as and a copy of it are not decisions about the picture, they
     are the picture. TRY AGAIN and CONTINUE JOURNEY stay off, because what
     you are looking at is usually not this rung's result - it is the frame
     carried into its slot - and both of those would answer for a run that
     did not happen here. */
  /* AND WHAT YOU MADE HERE GETS THE WHOLE PANEL - Babe, 2026-10-27: "when
     you double click on the generated result after closeing the modal we
     should just make the modal the same so you can always just click
     continue the journey to apply the background image and go to the next
     working". A result is a proposal and Continue journey is the acceptance,
     and before this the only place that press existed was the panel that
     opened by itself - so closing it once put the acceptance out of reach
     and the room never changed. The bigger look is now the same panel when
     what is in it is this workflow's own output.
     IT IS STILL OFF FOR EVERYTHING ELSE, which is what the first version of
     this note was right about: most boxes hold what was carried INTO this
     workflow, and TRY AGAIN and CONTINUE JOURNEY there would answer for a run
     that did not happen here.
     THE TEST IS THE NAME. `st(rung).out` is the record of what this workflow
     made and the box may be painted from any of the three urls that record
     can resolve to - the proxy, the saved copy, a browser's own object URL -
     so the one thing they all agree on is the filename, which the server
     writes to be unique. */
  function ownOut(slide, src) {
    var out = st(rungOf(slide)).out;
    var name = out && out.filename;
    return name && fileFromSrc(src).filename === name ? out : null;
  }

  async function peek(slide, src, isVid) {
    var o = overlayOf(slide);
    o.querySelector('.runover-msg').textContent = '';
    var media = o.querySelector('.runover-media');
    media.innerHTML = '';
    var info = o.querySelector('.info');
    if (info) info.textContent = '';
    var el = document.createElement(isVid ? 'video' : 'img');
    if (isVid) { el.controls = true; el.loop = true; el.playsInline = true; el.autoplay = true; }
    /* the listener goes on before the src, or a cached file fires its load
       while nothing is listening - the same order the result panel keeps. */
    el.addEventListener(isVid ? 'loadedmetadata' : 'load', function () {
      if (!info) return;
      var w = el.naturalWidth || el.videoWidth, h = el.naturalHeight || el.videoHeight;
      if (!w || !h) return;
      var made = madeWith(src, rungOf(slide));
      info.innerHTML = '<b>' + (isVid ? 'Video' : 'Image') + '</b>' +
        w + ' × ' + h + '  ·  ' + ratioName(w / h) +
        (el.duration ? '  ·  ' + el.duration.toFixed(1) + 's' : '') +
        (made ? '  ·  ' + made : '');
    });
    el.src = src;
    media.appendChild(el);
    var file = fileFromSrc(src);
    var rung = rungOf(slide);
    var own = ownOut(slide, src);
    var buttons = [{ label: isVid ? 'Save clip' : 'Save image',
                     onClick: function () { saveFile(rung, file); } }];
    if (own) {
      buttons.push({ label: 'Cancel', onClick: function () { closeResult(); } });
      /* the same reach the result panel has, read the same way: the last
         workflow has nowhere to carry to and nothing else does. */
      if (rung < window.HJ.slides.length) {
        buttons.push({ label: 'Continue journey', primary: true,
                       onClick: function () { carry(slide, rung, own); } });
      }
    }
    acts(slide, buttons);
    await ready(el);
    o.classList.add('is-on');
    /* AND THE PLATE IS THE RESULT PANEL'S WHEN THE FOOT IS. `.is-peek` is one
       tighter inset for a look with a single cell under it; a full strip wants
       the room the panel reserves for one. */
    o.classList.toggle('is-peek', !own);
  }

  function acts(slide, buttons) {
    var row = overlayOf(slide).querySelector('[data-acts]');
    row.innerHTML = '';
    buttons.forEach(function (b) {
      var el = document.createElement('button');
      el.className = b.primary ? 'run' : 'ghost';
      el.textContent = b.label;
      el.addEventListener('click', b.onClick);
      row.appendChild(el);
    });
  }

  /* --------------------------------------------------------------- running */

  async function valuesFor(slide, rung) {
    var s = st(rung);
    var v = {};
    var map = SLOTS[rung];
    /* A PRESET SOURCE IS A GUIDE, AND THE RUN HAS TO SAY SO - Babe,
       2026-10-26: "otherwise all character will look like the preset". The
       mannequin is in the box as a stand-in for a face nobody has brought,
       and the scaffolding this rung normally sends swears that face survives
       exactly. The server swaps the instruction on this flag; it reaches no
       node, the same way `lens` and `face` ride along on 03 and 06.
       IT READS THE PRESSED CELL, which is the one thing that knows a preset
       is what is showing - the same test the corner X asks. */
    if (s.src && s.src[map.left] === 'preset') v.guide = true;
    if (s.src && s.src[map.left] === 'webcam') v.cam = true;
    if (s.src && s.src[map.left] === 'import') v.custom = true;
    /* AND A SLOT CANNOT SEND A FILE IT COULD NOT HOLD - Babe, 2026-10-27,
       on a 06 that failed: "i wonder if its because of the api tho". It was
       not: the executed graph came back `LoadImage { image: "….mp4" }`. The
       character face was empty, the carry fell back to what the workflow
       behind it made, and 05 makes a clip - the hazard this file wrote down
       the day the carry was built and then built without the check.
       IT IS ASKED HERE BECAUSE THIS IS WHERE A NAME BECOMES A PAYLOAD. The
       resolution happens in three places and they do not all pass through
       `ensureFace`; every one of them ends up in this object. The slot table
       already declares what each side accepts, so there is nothing new to
       write down - and a name that fails the test is dropped rather than
       corrected, so the run refuses with `needs ref1` instead of sending a
       clip to an image loader. */
    var takes = (map.accept || {});
    var fits = function (key, side) {
      var name = s[key];
      if (!name) return false;
      var ok = !isVideoName(name) || /video/.test(takes[side] || '');
      if (!ok) {
        delete s[key];
        if (s.urls) delete s.urls[key];
        saveJourney();
      }
      return ok;
    };
    if (fits(map.left, 'left')) v[map.left] = s[map.left];
    if (map.right && fits(map.right, 'right')) v[map.right] = s[map.right];
    /* the back face is resolved at run time rather than here, but it is the
       same slot and the same question, so it is cleaned on the way past */
    if (map.alt) fits(map.alt, 'left');

    /* A BOX SHOWING WORDS DOES NOT ALSO SEND THE PICTURE BEHIND THEM. One
       box, one answer: the writing face covers the picture, so a run that
       sent both would be handing the model two answers to one question - a
       style reference AND a description of a different character - which is
       the averaging trap that has already cost this rail a clip and a face.
       Measured: writing "a deep sea diver in a brass helmet" into a STYLE
       slot holding a garage still sent the still as `ref`. */
    /* UNLESS THE WORDS ARE ABOUT THE PICTURE RATHER THAN INSTEAD OF IT.
       `data-keeps` is the box saying its two answers are to two different
       questions - 06's clip is the performance and its words are what to
       change about it - and that clip is `required`, so dropping it would
       refuse the run rather than tidy it. Everywhere else the rule stands:
       one box, one answer. */
    var writing = slide.querySelector('.slot.writes.is-asking');
    if (writing) {
      var wb = boxesOf(slide);
      var keeps = function (box) { return box && box.dataset.keeps === '1'; };
      if (map.left && wb.front[0] && !keeps(wb.front[0])
          && writing.contains(wb.front[0])) delete v[map.left];
      if (map.right && wb.front[1] && !keeps(wb.front[1])
          && writing.contains(wb.front[1])) delete v[map.right];
    }

    /* THE LINE SHOWS CHIPS AND SENDS WORDS. On a rung whose prompt is
       composed from a form, the field names stand in for the text so the page
       does not print the same sentence twice; `motionText` puts the values
       back. Any other rung has no chips in it and comes back unchanged. */
    var agent = (window.HJ && window.HJ.motionText)
      ? window.HJ.motionText(slide)
      : ((slide.querySelector('.agent-v') || {}).textContent || '');
    /* A WRITING FACE IS A WORDS BOX WEARING A SLOT. `.say` is the box 04 and
       05 are built around; `.slot.writes` is the same thing folded into a
       slot on 01, where the box has a picture's job on the other tab. Both
       are the artist's half of the prompt, so the run reads whichever one
       this rung has. The box's own memory answers when the face is closed,
       because the words outlive it. */
    var saidEl = slide.querySelector('.say');
    var said = saidEl ? saidEl.textContent : '';
    if (!said) {
      var wbox = slide.querySelector('.slot.writes .ask');
      var wdrop = slide.querySelector('.slot.writes .drop');
      /* AND A REMEMBERED SENTENCE IS A DRAFT ONCE A PICTURE IS BACK IN THE
         BOX. The box keeps what you wrote so a glance at the other tab does
         not cost it, but a slot showing a picture has answered with the
         picture - words still travelling from behind it are the same lie as
         a picture travelling from behind words, read the other way round. */
      said = wbox ? wbox.textContent
           : (wdrop && !wdrop.classList.contains('is-filled')
               ? (wdrop.dataset.said || '') : '');
    }

    /* Only what the artist wrote. The scaffolding belongs to the model, so
       the server holds it per variant and prepends it — it never reaches the
       browser and there is nothing here to keep in sync. */
    v.prompt = [said.trim(), agent.trim()].filter(Boolean).join(' ');

    /* AND THE BOX TABLE RIDES AT THE END, which is the one place it can go:
       BFL's annotator format is the instruction paragraph, ONE SPACE, then
       one JSON array, and the server's scaffolding is already in front of
       the paragraph. So the three parts land in the order the model was
       trained to read them without anything having to know about the other
       two.
       IT IS THE ONLY PLACE A RUN KNOWS THIS FACE EXISTS, because the
       sentence came through the writing box like every other sentence.
       AND NUMBERS ARE NOT WORDS, which is why they are not in the line the
       artist edits: the boxes on the picture ARE the visible form of this
       table, so `what you are looking at is what gets sent` holds - you are
       looking at them, drawn on the thing they point at, rather than at
       sixteen integers in a prompt box. */
    if (window.HJ && window.HJ.boxTable) {
      var bslot = slide.querySelector('.slot[data-boxes]');
      var table = bslot ? window.HJ.boxTable(bslot) : [];
      /* AND A PICTURE WITH BOXES ON IT IS THE SUBJECT, NOT A SECOND
         REFERENCE - Babe, 2026-10-29, on `NEEDS SOURCE` over a drawn box:
         "i think for these we need the image loaded in edit to be the
         source".
         THE RIGHT SLOT ON EDIT IS NORMALLY THE THING THE INSTRUCTION REFERS
         TO - a jacket, a hat - and this file has refused to make it the
         subject before, because a character there is the averaging problem
         one tab over. A TABLE OF COORDINATES IS THE EXCEPTION THAT PROVES
         IT: boxes drawn on a picture anchor every word to a position in
         THAT picture, so it cannot be a loose second reference to be
         averaged - it is the thing being edited, by construction.
         ONLY WHEN THERE IS NO SOURCE. With one in the left slot both go,
         the table cites `ref_image_1`, and nothing moves - which is the
         take-that-and-put-it-here job the format exists for. */
      if (table.length && !v.source && v.ref) {
        v.source = v.ref;
        delete v.ref;
        /* and the table has to say so, or it names an image that is now the
           other one - the box-lying rule read from the payload's end */
        table.forEach(function (row) {
          if (row.from === 'ref_image_1') row.from = 'ref_image_0';
        });
      }
      if (table.length && v.prompt) {
        v.prompt = v.prompt + ' ' + JSON.stringify(table);
      }
    }

    /* ON 04 THE TWO LINES ARE TWO JOBS, NOT ONE SENTENCE - Babe, 2026-10-25:
       "swap... thats why we renamed the prompt to motion prompt below". The
       DIRECTION panel writes the board: one framing, six, or a first and a
       last. The MOTION PROMPT drives the clip that the board, the hero frame
       and the sheet are handed to. Gluing them together sent the layout
       instruction to the video model and the motion instruction to the
       layout, which is each one arriving at the wrong machine. */
    /* 04's TWO JOBS ARE TWO RUNGS NOW. This used to split the page's two
       text boxes between the board and the clip - the direction to the layout
       model, the motion to the video model - each arriving at the right
       machine. 05 has one box and 04 has one form, so neither needs it. */

    /* the params are controls now, so Run reads whatever they are showing */
    v.model = modelOf(slide);
    /* both shapes of the same answer: a graph that samples an empty latent
       wants pixels, a partner node wants the ratio as a label. Each variant
       maps the one it needs and ignores the other. */
    v.ar = param(slide, 'ar');
    var size = arSize(v.ar, MEGAPIXELS[rung]);
    v.width = size.width;
    v.height = size.height;

    /* A READOUT CAN STILL BE AN INPUT. DUR says how long the clip you
       brought is, and Seedance in reference mode and H3 both take a real
       duration - so the honest number to send for a shot built on your
       performance is your performance's own length. It stays uneditable
       because it is not a decision: the clip already made it. The cell shows
       AUTO when there is no clip, which sends nothing and leaves the rung's
       own default standing.
       EXTEND IS THE ONE EXCEPTION and it is the server's: there the duration
       is the length of the NEW segment, so that mode carries its own. */
    if (rung === 6 && modeOf(slide) !== 'EXTEND') {
      var durEl = slide.querySelector('.param[data-p="duration"] b');
      var secs = durEl && parseFloat(durEl.textContent);
      if (secs && isFinite(secs)) v.duration = Math.max(4, Math.min(30, Math.round(secs)));
    }

    /* only a locked seed is sent; otherwise the server rolls one and the cell
       is updated to whatever it used. */
    var seedEl = slide.querySelector('.param[data-p="seed"]');
    if (seedEl && seedEl.dataset.lock === '1') v.seed = +param(slide, 'seed');
    if (rung === 1) v.steps = +param(slide, 'steps') || 8;
    /* AND THE WHOLE TRAIT SET RIDES ALONG FROM 02 ONWARDS, which it only ever
       half did: it reached 02, where the visible half goes in front of what
       the artist typed, and was thrown away on every rung after. 02 files
       them beside the sheet it makes, 03 and 04 are told the half a picture
       cannot show, and 05 and 06 read them as motion context - which is what
       the card was cut down to five fields for. WHAT EACH RUNG DOES WITH THEM
       IS A FLAG ON THE RUNG, on the server, so all this has to do is send
       them. */
    if (rung >= 2) v.traits = traitsObj();
    /* The panels and the visible traits are the artist's half of the prompt,
       so they go in front of what they typed. */
    if (rung === 2) {
      var sh = sheetOf(slide);
      v.sheet = sh && sh.id;
      /* THE SHEET OWNS THE RATIO. A 3x3 that stands up and a row of four that
         lies down are different pages, so the picker sets the shape and the
         AR cell is not on this rung's row at all. */
      if (sh && sh.ar) {
        v.ar = sh.ar;
        var sz = arSize(sh.ar, MEGAPIXELS[rung]);
        v.width = sz.width; v.height = sz.height;
      }
      /* THE LAYOUT GOES AS A PICTURE, NOT ONLY AS WORDS. The template is the
         model's second reference, so the sentence names panels by the label
         drawn on it and the two halves cannot describe different pages.
         A template that will not rasterise or upload throws, and the run
         stops with that on screen: a sheet built from the sentence alone,
         with no page behind it, is the failure that looks like success. */
      v.template = await templateFor(sh, v.width, v.height);
      v.prompt = [panelSentence(sh), traitSentence(slide), v.prompt].filter(Boolean).join(' ');
    }
    /* LENS IS PROMPT-SHAPING, NOT A NODE INPUT. No graph here has a lens, so
       it rides as a value the server folds into the scaffolding - the same
       trick the sheet's panel list uses. */
    if (rung === 3) v.lens = param(slide, 'lens');
    if (rung === 5) v.duration = parseInt(param(slide, 'duration'), 10) || 5;
    return v;
  }

  /* ---------------------------------------------------- the sheet and traits */

  /* THE LAYOUT IS THE ARTIST'S CHOICE, SO IT TRAVELS AS THEIR WORDS. The
     panel descriptions live in mockup.html beside the previews - one table
     draws the thumbnail, the template and this sentence - and the server
     adds only the scaffolding that belongs to the model. */
  /* WHICH PAGE THE TRAY IS SHOWING. The mode is the second half of 04's
     address: SINGLE and SEQUENCE are the same graph with a different number
     of references in it, TRANSITION is a different node. Every other rung
     has no mode cells and sends null, which the server ignores. */
  /* THE PANEL'S RUN DRAWS THE BOARD, which is 04's first generation and a
     different machine from the one the slide's RUN uses: nano takes the hero
     frame and the mode's layout page and reframes the scene into it, exactly
     the way 02 fills a character sheet. The board it makes is what the video
     model is handed afterwards, so it is kept on the rung's state as a third
     reference rather than just shown. */
  /* THE BOARD CUT BACK INTO ITS PANELS, 2026-10-29 - Babe, pointing at the
     multiframe template: "maybe this one", "for multiframe board?".
     A BOARD IS A TIMELINE AND THIS IS WHERE IT BECOMES ONE. 04 drew six
     framings into one page from a table of rectangles; this reads the same
     table back and lifts each panel out as its own picture, so what reaches
     the model is six frames at six moments rather than one grid it has to be
     talked out of copying. The rectangles are fractions, so the crop is the
     same arithmetic at any size the board came back at.
     IT IS THE PICTURE IN THE BOX, not `st(4).out`: what you are looking at is
     what gets sent, and the box may be holding something imported. */
  async function cutPanels(img, layout) {
    var out = [], W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
    for (var i = 0; i < layout.panels.length; i++) {
      var q = layout.panels[i];
      var c = document.createElement('canvas');
      c.width = Math.max(8, Math.round(q.w * W));
      c.height = Math.max(8, Math.round(q.h * H));
      c.getContext('2d').drawImage(img, Math.round(q.x * W), Math.round(q.y * H),
                                   c.width, c.height, 0, 0, c.width, c.height);
      var blob = await new Promise(function (r) { c.toBlob(r, 'image/png'); });
      if (!blob) throw new Error('the board would not cut');
      out.push(await uploadBlob(blob, 'panel-' + (i + 1) + '-' + Date.now() + '.png'));
    }
    return out;
  }

  /* WHERE EACH PANEL LANDS, IN FRAMES. The graph snaps the length onto H3's
     own grid - 17k + 5 at 24fps - and the anchors have to be placed inside
     THAT, so the snap is done here the same way the expression in the graph
     does it. The first panel is frame 0 and the last is the final frame; the
     rest are spread evenly between them.
     (*) IT IS THE ONE NUMBER WRITTEN DOWN TWICE, here and in the graph's own
     expression. The alternative is a chain of math nodes per panel, which is
     a lot of graph to avoid one line. */
  function anchorFrames(seconds, n) {
    var f = Math.max(5, Math.round((Number(seconds) || 5) * 24));
    var len = f + (5 - (f % 17)) % 17;
    var at = [];
    for (var i = 0; i < n; i++) {
      at.push(n < 2 ? 0 : Math.round((i / (n - 1)) * (len - 1)));
    }
    return at;
  }

  function modeObj(id) {
    var all = window.HJ.modes || [];
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }

  async function runBoard(slot, cell) {
    var slide = slot.closest('.slide');
    var mode = modeObj(slot.dataset.mode);
    /* NOT `say` - THAT IS THE FUNCTION THAT REPORTS FAILURES. A local of the
       same name shadowed it, so every error path in here called a DOM element
       and threw a TypeError on its way to saying what went wrong. The failure
       above arrived as complete silence because of this, which is the worst
       thing a catch block can do. */
    var box = slot.querySelector('.say');
    var said = box ? box.textContent.trim() : '';
    if (!mode || !said || cell.disabled) return;

    /* AND THE PANEL GOES FIRST, WHICH IS THE ONE LINE 04 NEVER GOT - Babe,
       2026-10-27: "try again on teh modal does nothing it should basically
       just close it", "so maybe it ran twice idk". It did run, exactly once,
       behind the panel you were still looking at: `run()` clears the overlay
       at the top and 04 returns into this function three lines before that,
       so every TRY AGAIN here redrew the board under a modal showing the
       board it was replacing. THE MODAL ONLY OPENS ON A RESULT - while a job
       runs nothing covers the panel, and that rule had one rung it was not
       true on. The error path reopens it by itself, through `say`. */
    var over = overlayOf(slide);
    over.classList.remove('is-on');
    over.querySelectorAll('video').forEach(function (v) { v.pause(); });
    over.querySelector('.runover-media').innerHTML = '';
    var omsg = over.querySelector('.runover-msg');
    if (omsg) { omsg.textContent = ''; omsg.classList.remove('bad'); }
    acts(slide, []);

    /* THE FRAME HAS TO BE RESOLVED THE WAY EVERY OTHER RUN RESOLVES ONE.
       This read `st(4).start` alone, which was true while the only way into
       this job was a cell inside the panel - the slot had always been filled
       by hand or by a carry. It is the rung's own RUN now, so it meets the
       two cases `run()` already handles: a box painted from output/ and
       marked rather than uploaded, and a frame that is still only 03's
       output. Showing a picture the model never got is the failure that
       looks like success. */
    var figure;
    try { figure = await ensureLeft(slide, 4); }
    catch (err) { return say(slide, String(err && err.message || err), true); }
    if (!figure) return say(slide, 'the hero frame has to be there first', true);

    /* RUN BECOMES THE CLOCK, THE WAY IT DOES ON EVERY OTHER RUNG - Babe,
       2026-10-26: "button also says DRAWING". That word is left over from
       when this job was run by a cell inside the panel, where a label naming
       the job was the only thing it could say; it is the rung's own RUN now,
       and the rung's RUN counts. */
    /* AND THE RULE UNDER THE PROMPT FILLS - Babe, 2026-10-26: "idk if the red
       progress bar is working in this section". It was not: this job was
       written as a second generation on somebody else's rung, where the bar
       belonged to the rung's own run and the box drew its own waiting mark.
       There is one run on this page now, so it fills the one bar, against
       this rung's measured time exactly as every other rung does. */
    var label = cell.textContent;
    cell.disabled = true;
    cell.classList.add('is-running');
    var bar = slide.querySelector('.prog');
    var fill = bar && bar.querySelector('i');
    var eta = slide._eta || 20000;
    if (bar) bar.classList.remove('is-done');
    if (fill) fill.style.width = '0%';
    var t0 = Date.now();
    var clock = setInterval(function () {
      var ms = Date.now() - t0;
      cell.textContent = (ms / 1000).toFixed(1) + 's';
      /* it holds at 92 until the file is really there: Comfy returns a state
         and never a progress, so the last stretch is the only honest part. */
      if (fill) fill.style.width = Math.min(92, (ms / eta) * 92).toFixed(1) + '%';
    }, 100);
    var drew = false;
    /* AND THE BOARD LANDS IN A BOX THAT IS ON SCREEN. `is-working` hands the
       square over to the destination, and the agent face is a different
       square in the same column - so pressing RUN from inside the agent drew
       BOTH, standing the slot 400px taller than the one beside it. Babe,
       2026-10-26: "agent broke the ui". The run is the answer to the
       conversation, so the conversation steps back out of the way. */
    if (slot.classList.contains('is-agent') && window.HJ.faceHome) {
      window.HJ.faceHome(slot, 'Prompt');
    }
    /* THE EDITING FACE IS LEFT ALONE, AND THAT WAS LEARNED THE HARD WAY.
       Taking `is-editing` off here fixed the height and broke the box: a
       writing face stands on a PLATE - the picture behind the glass - and
       dropping the class walked out of the face without taking the plate
       with it, so the board box came back holding the old plate AND the new
       result side by side. Babe: "yeah if fixes when its done generating but
       then looked like this". A class is not a way out of a face; the way
       out restores what the face borrowed. The height is a stylesheet
       question and it is answered in the stylesheet. */
    slot.classList.add('is-working');
    /* the same three squares the style roll puts in its slot, in the box the
       board is about to land in. */
    var into = slot.querySelector('.boardbox');
    var wait = document.createElement('div');
    wait.className = 'wait';
    wait.innerHTML = '<i></i><i></i><i></i>';
    if (into) into.appendChild(wait);
    try {
      var single = slot.dataset.mode === 'single';
      /* AND A SINGLE FRAMING TAKES ITS SHAPE FROM THE FRAME IT RE-FRAMES -
         Babe, 2026-10-27: "i thought think it has to use the original image
         as the source / width and height", then "aspect ratio is worse now".
         The layout page decided it before, which is right for a board - the
         board IS the page - and arbitrary for one photograph: shoot 03
         vertical and 04 would hand back a 16:9 letterbox of it. */
      /* AND THE ROW DECIDES THE SHAPE, WHICH THE CELL ONLY LOOKED LIKE IT
         DID - Babe, 2026-10-29, on the first board after AR went on the row:
         "hm... doesn't seem like a wider image", "they almost look square".
         It was not: 1888 x 1072, 16:9, with 21:9 showing in the cell.
         `mode` HERE IS THE LAYOUT, NOT THE ROW. `mode.ar` is the ratio the
         PRESET was drawn at - the thing the board's page has always been
         sized by - so adding a cell to the row left the page, the latent and
         the ratio all reading a table the artist cannot touch. A control
         that does nothing is the one thing this panel has a rule against,
         and it was mine for an hour.
         AND THE PANELS WERE SQUARE FOR A REASON THE CELL NOW FIXES: a 3 by 2
         grid inside 16:9 makes every cell 1.19:1. Wide frames need a wide
         page - at 21:9 each one is 1.56:1 - which is exactly what the cell
         was asked for. */
      var want = param(slide, 'ar');
      var size = arSize(/^[0-9]+:[0-9]+$/.test(want) ? want
                                                     : (mode.ar || '16:9'), MEGAPIXELS[4]);
      if (single) {
        var fim = (boxesOf(slide).front[0] || {}).querySelector &&
                  boxesOf(slide).front[0].querySelector('img');
        if (fim && fim.naturalWidth) {
          size = arSize(fim.naturalWidth + ':' + fim.naturalHeight, MEGAPIXELS[4]);
        }
      }
      /* AND NO TEMPLATE WHERE THERE IS NO LAYOUT. A blank page of zero
         panels is a black rectangle, and handing a model a reference that
         means nothing is worse than handing it none: `dropWhenEmpty` takes
         475 out and the scaffolding stops addressing it.
         A SINGLE FRAMING IS THAT CASE TOO, AND IT TOOK THREE SYMPTOMS TO SEE
         IT - Babe, on one run: "aspect ratio is worse now", "added white
         bars", "should also be an extreme close-up". One page of one panel
         says nothing a width and a height do not, and it costs the whole of
         what it says: the model paints the template's white, the page's
         ratio outranks the frame's, and a second reference takes attention
         from the only instruction on the screen. The board keeps its page,
         because there the page IS the job. */
      var free = !mode.panels.length || single;
      /* THE BIBLE RIDES ALONG - Babe, 2026-10-26: "maybe we need to use a
         reference image for it", "similar to sheets". The sheet is on the
         back of this slot and was the one thing on the rung going nowhere;
         a board asks for the face at six distances and the hero frame only
         ever showed one of them. It is optional: without one the loader
         drops and the sentence stops mentioning it. */
      /* AND THE RATIO IS THE FRAME'S TOO ON A SINGLE FRAMING, snapped to a
         name a partner node will take - nano reads a label where qwen reads
         the pixels. `ratioName` falls back to "1.79:1" when nothing is
         within 2%, and no node has heard of that, so an odd frame keeps the
         rung's own default rather than sending one. */
      var shotAr = /^[0-9]+:[0-9]+$/.test(want) ? want : (mode.ar || '16:9');
      if (single) {
        var named = ratioName(size.width / size.height);
        if (/^[0-9]+:[0-9]+$/.test(named)) shotAr = named;
      }
      var sheet = '';
      try { sheet = await ensureFace(slide, 4, 'sheet', boxesOf(slide).alt[0], st(2).out); }
      catch (err) { /* the board is still a board without it */ }
      /* THE LIGHT RIDES IN AS A VALUE AND REACHES NO NODE, the way `lens`
         does on 03 and `face` on 06: the server reads it to decide whether
         the scaffolding keeps insisting the light comes from image 1. AUTO
         is the absence of an answer, which `composeDirection` already knows
         - it is the same test, asked of the same cell. */
      var lightDial = slot.querySelector('.dial[data-k="light"] .tr b');
      var light = lightDial ? lightDial.textContent.trim() : '';
      var values = {
        figure: figure,
        sheet: sheet,
        light: light === 'Auto' ? '' : light,
        /* AND THE PAGE CAME BACK THE SAME HOUR, WHICH IS WHAT IT IS FOR -
           Babe, 2026-10-29, looking at the words-only board: "i just think
           all the frames should be equal".
           THE EXPERIMENT ANSWERED ITS OWN QUESTION. Without a page the board
           came back with no captions and thin black divisions, which is the
           half that was wrong before - and with its columns out of line and
           its panels unequal, although the sentence asks in so many words for
           a 3 by 2 grid of EQUAL panels. Words can say what a layout is;
           only a drawing can make it exact.
           SO IT IS THE BARE PAGE: geometry from the picture, and nothing
           printed on it to letter. The two failures were never the same
           failure, and this is the arrangement that answers both. */
        template: free ? '' : await templateFor(mode, size.width, size.height, true),
        /* AND A SINGLE FRAMING HAS NO PANELS TO DESCRIBE - Babe, 2026-10-27:
           "single should not have cells", "its literally a single image
           edit". The page went with the template; this is the sentence that
           was still naming it, opening "Lay the image out as a contact sheet,
           exactly as the layout template shows: 1 panel in the position it
           gives it" in front of a job with no template in it. One image in,
           one image out, and nothing in the prompt about pages. */
        prompt: [free ? '' : panelSentence(mode, true), said].filter(Boolean).join(' '),
        ar: shotAr,
        width: size.width,
        height: size.height
      };
      /* NO `step` AND NO HARD-CODED MODEL. Both were true of a generation
         that lived inside a panel on somebody else's rung: the server
         resolved it through `RUNGS[4].steps.board` and the page had no row
         to read a model from. It is `RUNGS[4]` itself now and the rung wears
         the picker, so the model comes off the row like every other rung's
         and a payload that still said `step` would be describing a shape the
         server no longer has. */
      var job = await submitAndWait({
        rung: 4, model: modelOf(slide),
        mode: slot.dataset.mode, values: values
      });
      if (!job.ok) throw new Error(job.error || 'the board would not draw');

      /* THE POLL CALLS THEM `outputs`. This read `job.files`, which is
         undefined on every job the server has ever returned, so a board that
         drew perfectly well was reported as empty and thrown away - twice,
         with both files sitting in output/ the whole time. */
      var made = (job.outputs || [])[0];
      if (!made) throw new Error('the board came back empty');

      if (into) showMedia(into, lastingUrl(made), false);
      slot.classList.remove('is-editing');
      slot.classList.add('has-board');
      if (window.HJ.boardHead) window.HJ.boardHead(slot, false);

      /* into Comfy's input store, so the video step can reference it */
      /* AND IT IS THIS RUNG'S OUTPUT NOW, not a by-product of it. 05 wears
         the board on its left slot and carries it at run time, both of which
         read `st(4).out` - and the section stands in the room it made, the
         same as every other rung. */
      /* THE PLAN INCLUDES WHICH KIND OF SHOT IT IS, and 05 needs it: SINGLE
         and SEQUENCE share the reference graph while TRANSITION is a
         different node entirely. It was one rung's `modeOf` until the split
         and 05 has no tabs of its own, because the choice was made here. */
      st(4).mode = slot.dataset.mode;
      st(4).out = made;
      /* AND THE ROOM STILL WAITS FOR CONTINUE JOURNEY. This dressed 04 the
         instant the board landed, which is the order the whole rail moved
         off: a result on screen is a proposal, and the press that accepts it
         is the one that changes the room. It was written when the board was
         a step on the way to this rung's real output. */
      saveJourney();

      /* into Comfy's input store, so the motion rung can reference it */
      var cres = await fetch('/api/carry', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(made)
      });
      var cjson = await cres.json();
      if (cres.ok && cjson.name) { st(4).board = cjson.name; saveJourney(); }
      drew = true;
      /* AND IT OPENS THE RESULT PANEL, NOT A LOOK. The board is what this
         rung makes, so it arrives as a proposal with the foot every other
         rung's result wears - Babe, 2026-10-26: "for this result we do need
         the save image and continue journey". It opened through `peek` from
         the days when the rung had a second generation after it, where the
         board really was only something to look at on the way. */
      await showResult(slide, 4, made);
    } catch (err) {
      say(slide, String(err && err.message || err), true);
    } finally {
      /* it goes whatever happened - showMedia clears the box on success, and
         on a failure an animation that keeps running says a job still is. */
      if (wait.parentNode) wait.parentNode.removeChild(wait);
      slot.classList.remove('is-working');
      clearInterval(clock);
      cell.disabled = false;
      cell.classList.remove('is-running');
      cell.textContent = label;
      if (bar) bar.classList.add('is-done');
      if (fill) {
        fill.style.width = drew ? '100%' : '0%';
        if (drew) setTimeout(function () { fill.style.width = '0%'; }, 1400);
      }
    }
  }

  /* THE BOARD BOX HAS THE SAME ONE GESTURE EVERY OTHER BOX HAS - Babe,
     2026-10-25: "make it so you can double click on it for full screen too.
     ref the other sections". Delegated rather than bound per slot, because
     this box is built by the page rather than by the slot wiring. */
  document.addEventListener('dblclick', function (e) {
    var box = e.target.closest && e.target.closest('.boardbox');
    if (!box) return;
    var shown = box.querySelector('img, video');
    if (!shown) return;
    e.preventDefault();
    peek(box.closest('.slide'), shown.src, shown.tagName === 'VIDEO');
  });

  /* A BOARD YOU BRING - Babe, 2026-10-26: "it should actually be PROMPT,
     IMAGE and IMPORT". Every other slot on the rail offers one and this is
     the only box that made something without being able to be handed one.
     IT IS WIRED LIKE A SLOT'S IMPORT AND NOT LIKE A SLOT: `bindSlot` binds a
     file chooser to a `.drop`, and this box is not one, so the cell is
     delegated and keeps its own picker. What it writes is `st(4).out` - the
     board is what this rung has, however it got there - so 05's left slot,
     the carry and the reload all keep working with nothing new to know. */
  async function importBoard(slot, file) {
    var slide = slot.closest('.slide');
    var box = slot.querySelector('.boardbox');
    if (!box) return;
    box.classList.add('is-busy');
    try {
      var res = await fetch('/api/upload?name=' + encodeURIComponent(file.name), {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file
      });
      var out = await res.json();
      if (!res.ok) throw new Error(out.error || 'upload failed');
      var at = '/api/file?filename=' + encodeURIComponent(out.name) +
               '&subfolder=&type=input';
      st(4).board = out.name;
      /* shown from the browser's own copy, which is instant; remembered as
         the server's, which is the one that survives a reload. */
      showMedia(box, URL.createObjectURL(file), false);
      box.dataset.fromFile = '';
      st(4).out = { filename: file.name, url: at, saved: '' };
      slot.classList.remove('is-editing', 'is-inface');
      slot.classList.add('has-board');
      if (window.HJ.boardHead) window.HJ.boardHead(slot, false);
      saveJourney();
      paintSheetFace();
    } catch (err) {
      say(slide, String(err.message || err), true);
    } finally {
      box.classList.remove('is-busy');
    }
  }

  document.addEventListener('click', function (e) {
    var cell = e.target.closest &&
               e.target.closest('.slot.has-form .tray .tr[data-act="import"]');
    if (!cell) return;
    var slot = cell.closest('.slot');
    var picker = slot.querySelector('input.board-pick');
    if (!picker) {
      picker = document.createElement('input');
      picker.type = 'file';
      picker.accept = 'image/*';
      picker.className = 'board-pick';
      picker.style.display = 'none';
      picker.addEventListener('change', function () {
        var f = picker.files && picker.files[0];
        picker.value = '';
        if (f) importBoard(slot, f);
      });
      slot.appendChild(picker);
    }
    picker.click();
  });

  /* THROWING THE BOARD AWAY. Delegated, because this box is built by the
     page rather than by the slot wiring - the same reason its double-click
     is. It clears what the rung made as well as what is in the box: a board
     you threw away must not be the thing 05 carries. */
  document.addEventListener('click', function (e) {
    var x = e.target.closest && e.target.closest('.board-x');
    if (x) {
      e.stopPropagation();
      var bslot = x.closest('.slot');
      if (!bslot) return;
      var box = bslot.querySelector('.boardbox');
      if (box) {
        var shown = box.querySelector('img, video');
        if (shown) shown.remove();
        box.classList.remove('is-filled');
        if (box.parentNode) box.parentNode.classList.remove('is-full');
      }
      bslot.classList.remove('has-board', 'is-editing');
      if (window.HJ.boardHead) window.HJ.boardHead(bslot, true);
      delete st(4).out;
      delete st(4).board;
      saveJourney();
      return;
    }
    var cell = e.target.closest && e.target.closest('.tray .tr[data-act="agentrun"]');
    if (!cell) return;
    var slot = cell.closest('.slot');
    if (slot) runBoard(slot, cell);
  });

  /* WHOSE WORDS ARE IN THE BOX. A rung's `sys` is scaffolding written for a
     direction the agent composed; in front of a line the artist typed it is
     a second voice talking over the first. A slot with no words box at all
     answers false and keeps the scaffolding it always had. */
  function rawOf(slide) {
    /* CUSTOM IS THE ONLY RAW ONE. A direction the form wrote is structured on
       purpose and still wants the rung's scaffolding in front of it; a line
       typed into the blank box is the artist saying they will handle it. */
    if (modeOf(slide) === 'custom') return true;
    var say = slide.querySelector('.say');
    return !!say && !slide.querySelector('.form') && say.dataset.by !== 'agent';
  }

  /* 04 KEEPS ITS MODE ON A NESTED PANEL AND 05 WEARS IT AS TABS, so the one
     question "which mode is this run" has two places to be answered from.
     The panel wins where there is one, because on 04 the mode IS the panel
     you are standing in. */
  function modeOf(slide) {
    var slot = slide.querySelector('.slot[data-mode]');
    if (slot && slot.dataset.mode) return slot.dataset.mode;
    var tab = slide.querySelector('.mtab[aria-pressed="true"]');
    return (tab && tab.dataset.m) || null;
  }

  function sheetOf(slide) {
    var all = window.HJ.sheets || [];
    var b = slide.querySelector('.sheet[aria-pressed="true"]');
    var id = b && b.dataset.sheet;
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return all[0];
  }

  /* IT USED TO SAY "A SINGLE ROW OF N PANELS OF EQUAL WIDTH", which is true
     of the turnaround and a lie about every other preset - Faces is 3x2,
     Bible is 3x3, and Hero has two portraits stacked beside two tall ones.
     Now the template carries the geometry and each instruction is addressed
     to the label drawn in that panel, which is the one name the picture and
     the sentence share. The table's own order is not reading order (Hero runs
     down a column first), so nothing here numbers them. */
  /* `bare` IS THE BOARD'S FORM OF THIS AND THE DEFAULT IS 02's. Both take a
     page; one addresses the type drawn on it and the other has none to
     address, so it says what each panel holds and asks for no lettering at
     all. Two wordings of one fact rather than two functions, so the panel
     list below is composed once.
     THE WORDS-ONLY WORDING IS IN THE HISTORY, not here: it was tried on
     2026-10-29, came back with unequal panels, and the page answered that in
     one run. Nothing on the rail asks for it, so nothing here carries it. */
  function panelSentence(sheet, bare) {
    /* A LAYOUT WITH NO PANELS HAS NOTHING TO SAY, and saying it anyway is
       how CUSTOM would have asked for a contact sheet of 0 panels - the
       same arithmetic that was asking for "1 panels" until today. */
    if (!sheet || !sheet.panels || !sheet.panels.length) return '';
    var parts = [];
    for (var i = 0; i < sheet.panels.length; i++) {
      var p = sheet.panels[i];
      /* A BARE PAGE HAS NOTHING TO ADDRESS BY NAME, so the panel is named by
         where it sits and by what it shows - two of the three ways it was
         always named, and the two that cost nothing to render. */
      parts.push(bare
        ? 'The panel in ' + cellOf(sheet, p) + ' is ' + p.says + '.'
        : 'The panel labelled "' + p.label.join(' ') + '" (' + cellOf(sheet, p) +
          ') is ' + p.says + '.');
    }
    /* "1 PANELS" WAS GOING TO THE MODEL. The count was written when every
       page this composed had several - four, six, nine - and 04's SINGLE is
       one panel, which has been asking for a contact sheet of "1 panels"
       since the board was built. A layout instruction that cannot count is a
       layout instruction a model is right to doubt. */
    var n = sheet.panels.length;
    if (bare) {
      /* THE PAGE IS THE GEOMETRY AND THE SENTENCE IS THE REST. Each panel is
         exactly where the template puts it and exactly the size it draws it,
         which is the one thing words could not hold - and then the two
         clauses the words pass was right about: nothing drawn between the
         panels, and nothing lettered anywhere. */
      return 'Lay the image out as a contact sheet, exactly as the layout ' +
             'template shows: ' + n + (n === 1 ? ' panel' : ' panels') +
             ' in the positions it gives them and at the sizes it draws them, ' +
             'meeting each other directly with no gap, line, gutter or border ' +
             'between them, and a narrow pure black border around the whole ' +
             'image. No words, letters, numbers or captions anywhere in the ' +
             'picture. ' + parts.join(' ');
    }
    return 'Lay the image out as a contact sheet, exactly as the layout template ' +
           'shows: ' + n + (n === 1 ? ' panel in the position it gives it, ' :
                                      ' panels in the positions it gives them, ') +
           (n === 1 ? 'holding what its label names, and a narrow pure black border ' +
                      'around the whole image. '
                    : 'meeting each other directly with no gap or line between them, ' +
                      'each holding what its own label names, and a narrow pure black ' +
                      'border around the whole image. ') + parts.join(' ');
  }

  /* WHERE A PANEL SITS, read off the rectangles the table already holds, so
     every panel is named three ways - by its label, by its cell and by what
     it shows - and the model can fail to find it only by not looking. Words
     were the first attempt and the turnaround breaks them: four columns of
     equal width, two of which are "centre". */
  function cellOf(sheet, p) {
    var xs = [], ys = [];
    sheet.panels.forEach(function (q) {
      if (xs.indexOf(q.x) < 0) xs.push(q.x);
      if (ys.indexOf(q.y) < 0) ys.push(q.y);
    });
    var up = function (a, b) { return a - b; };
    xs.sort(up); ys.sort(up);
    var col = 'column ' + (xs.indexOf(p.x) + 1) + ' of ' + xs.length;
    var row = 'row ' + (ys.indexOf(p.y) + 1) + ' of ' + ys.length;
    if (ys.length === 1) return col;
    if (xs.length === 1) return row;
    if (p.h > .99) return col + ', full height';
    if (p.w > .99) return row + ', full width';
    return col + ', ' + row;
  }

  /* THE TEMPLATE IS DRAWN ONCE AND SENT. The picker's thumbnail, the .svg on
     disk and the model's reference are one function of one table, so what was
     clicked really is what the model is handed - rasterised here at the run's
     own size and uploaded into Comfy's input folder like any other file.

     CACHED BY WHAT IT IS, NOT BY WHEN IT WAS MADE. The drawing is pure in the
     preset and the size, so the same choice is the same bytes: one upload per
     page covers every reroll of it. */
  var templates = {};
  /* AND IT CAN GO WITHOUT ITS LABELS - Babe, 2026-10-29, on the first board
     FLUX.3 KLEIN ever drew: "it worked but there are grid lines and text on
     them". Six panels, one face, real coverage - and every label painted
     into its own panel, "wide (establishing)" across the top left corner of
     the picture.
     IT WAS TOLD NOT TO, TWICE. `BOARD_LINE` says never copy its lines,
     gutters or labels and `panelSentence` says the panels meet with no gap
     or line between them. Words have now failed on this row once, and the
     lever this codebase prefers is the other one: DO NOT HAND A MODEL THE
     WORDS YOU ARE ASKING IT NOT TO DRAW. `sheetTemplate` has taken `bare`
     since the picker's thumbnail needed one, so the page is the same drawing
     minus its type.
     THE CACHE KEY CARRIES IT, because a bare page and a labelled one of the
     same preset and size are two different uploads and one key would serve
     whichever was asked for first. */
  async function templateFor(sheet, w, h, bare) {
    if (!sheet || !window.HJ.sheetTemplate || !w || !h) return '';
    var key = sheet.id + '-' + w + 'x' + h + (bare ? '-bare' : '');
    if (templates[key]) return templates[key];

    var svg = window.HJ.sheetTemplate(sheet, w, h, bare);
    var url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    try {
      var img = await new Promise(function (ok, bad) {
        var el = new Image();
        el.onload = function () { ok(el); };
        el.onerror = function () { bad(new Error('the layout template would not draw')); };
        el.src = url;
      });
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      var blob = await new Promise(function (r) { c.toBlob(r, 'image/png'); });

      var res = await fetch('/api/upload?name=' + encodeURIComponent('sheet-' + key + '.png'), {
        method: 'POST', headers: { 'Content-Type': 'image/png' }, body: blob
      });
      var out = await res.json();
      if (!res.ok) throw new Error(out.error || 'the layout template would not upload');
      templates[key] = out.name;
      return out.name;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /* ONLY THE TRAITS A PICTURE CAN SHOW. A voice and a temperament cannot
     change a still frame, so sending them would be noise in the prompt -
     they are carried instead, for the rungs that move. */
  /* THERE IS ONE CARD, SO THERE IS ONE READER OF IT. It lives on 02 and every
     rung after that is only ever TOLD what it says, so a reader scoped to a
     slide could only be handed 02's anyway - and `saveJourney` already had
     its own copy of this loop reading the document, which is one fact read
     two ways. */
  function traitsObj() {
    var o = {};
    (window.HJ.traits || []).forEach(function (t) {
      var el = document.querySelector('.tf[data-t="' + t.k + '"]');
      var v = el && el.textContent.trim();
      if (v) o[t.k] = v;
    });
    return o;
  }

  /* AND THE TRAIT'S NAME ONLY GOES IN WHEN THERE IS SOMETHING TO TELL IT
     APART FROM. It was written when NINE traits could be visible and four of
     them were - "age 40s, build lean, eyes brown" reads properly and needs
     every one of those words. The cut to five left `features` as the only
     `vis` trait, and a list of one does not need labelling: every 02 run
     since has been sending "The character is FEATURES serious expression,
     brown eyes, ...", which is a stale mechanism outliving the thing it was
     for, and ungrammatical on the way out. Found in a captured payload,
     2026-10-29.
     (*) THE STEM IS STILL "The character is", which reads a little oddly in
     front of a bare description. Babe's to change. */
  function traitSentence(slide) {
    var said = [];
    (window.HJ.traits || []).forEach(function (t) {
      if (!t.vis) return;
      var el = slide.querySelector('.tf[data-t="' + t.k + '"]');
      var v = el && el.textContent.trim();
      if (v) said.push({ n: t.n.toLowerCase(), v: v });
    });
    if (!said.length) return '';
    var parts = said.map(function (one) {
      return said.length > 1 ? one.n + ' ' + one.v : one.v;
    });
    return 'The character is ' + parts.join(', ') + '.';
  }

  /* whatever the trigger says is what gets sent; the server refuses a model
     it has no graph for rather than silently running the default. */
  function modelOf(slide) {
    var b = slide.querySelector('.param.model b');
    return b ? b.textContent.trim() : '';
  }

  /* A SHEET IS FOUR PICTURES IN A ROW, SO IT GETS MORE PIXELS THAN A FRAME.
     Every other rung makes one image and one megapixel is plenty. 02 lays
     four full-length views side by side, so at 3:2 and 1MP each figure got
     about 306px of width and each face about forty — and 03, 04 and 05 read
     the face and the wardrobe off this image and nothing else. At 2MP the
     same sheet gives each view 434px. Absent = 1. */
  /* 04's board is a drawn page the same way 02's sheet is, so it is sized
     the same way: enough pixels that each panel holds a readable frame. */
  var MEGAPIXELS = { 2: 2, 3: 2, 4: 2 };

  /* AR to pixels at roughly `mp` megapixels, on a multiple of 8 */
  function arSize(ar, mp) {
    var p = (ar || '1:1').split(':');
    var r = (+p[0] || 1) / (+p[1] || 1);
    var px = (mp || 1) * 1e6;
    var w = Math.round(Math.sqrt(px * r) / 8) * 8;
    var h = Math.round(Math.sqrt(px / r) / 8) * 8;
    return { width: w, height: h };
  }

  function param(slide, p) {
    var el = slide.querySelector('.param[data-p="' + p + '"] b');
    return el ? el.textContent.trim() : '';
  }

  /* The file comes back content-addressed, which is a terrible name to find
     in a downloads folder. Give it the rung it came from and the date. */
  function saveFile(rung, file) {
    var ext = (file.filename.match(/\.[a-z0-9]+$/i) || ['.png'])[0];
    var stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    var a = document.createElement('a');
    a.href = file.url;
    a.download = 'heros-journey-0' + rung + '-' + stamp + ext;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /* A reduced fraction gives you 43:24, which tells nobody anything. Snap to
     the ratio a person would have asked for, and fall back to a decimal only
     when it really is not one of them. */
  var RATIOS = [['1:1', 1], ['2:3', 2 / 3], ['3:2', 1.5], ['3:4', 0.75], ['4:3', 4 / 3],
                ['4:5', 0.8], ['5:4', 1.25], ['9:16', 0.5625], ['16:9', 16 / 9], ['21:9', 21 / 9]];
  function ratioName(r) {
    var best = null, bestErr = 1e9;
    RATIOS.forEach(function (pair) {
      var err = Math.abs(pair[1] - r) / r;
      if (err < bestErr) { bestErr = err; best = pair[0]; }
    });
    return bestErr < 0.02 ? best : r.toFixed(2) + ':1';
  }

  function isVideoName(n) { return /\.(mp4|webm|mov|m4v)$/i.test(n || ''); }

  /* ONE RESULT PANEL, AND EVERY JOB ON THE RAIL OPENS IT - Babe, 2026-10-26,
     on a board that came back with only SAVE IMAGE under it: "for this result
     we do need the save image and continue journey". 04 drew its board through
     `peek`, which is the bigger LOOK - no decisions, because a look is not a
     result. A board IS this rung's result, and a result is a proposal you
     accept or reject. The last of `runBoard`'s second-generation habits: it
     opened a look because the rung's own RUN used to send the clip after it.
     IT IS LIFTED OUT OF `run` RATHER THAN COPIED. The panel knows four things
     - what came back, how to say so, what you can do about it, and that it
     arrives finished - and a second copy is four things to get wrong, which
     is how the board ended up wearing a different foot in the first place. */
  async function showResult(slide, rung, file) {
    var o = overlayOf(slide);
    o.classList.remove('is-peek', 'is-shots', 'has-back', 'is-key');
    st(rung).out = file;
    saveJourney();
    paintSheetFace();

    /* THE ROOM IS NOT DRESSED HERE ANY MORE - see `dressRung`, which
       Continue journey calls. A rung's own output used to become its plate
       the instant the job landed, which was invisible while the panel
       opened in the same frame and is not any more.
       EXCEPT ON THE LAST RUNG, WHICH HAS NO CONTINUE TO WAIT FOR. It is the
       one that loops, so there is no acceptance press to hang this on and
       nothing to hold it back from - the same test the button below uses,
       so the two cannot disagree about where the rail ends. */
    if (rung >= window.HJ.slides.length) await dressRung(rung, file);


    var media = o.querySelector('.runover-media');
    media.innerHTML = '';
    var info = o.querySelector('.info');
    if (info) info.textContent = '';
    var el = document.createElement(isVideoName(file.filename) ? 'video' : 'img');
    if (el.tagName === 'VIDEO') { el.controls = true; el.loop = true; el.playsInline = true; el.autoplay = true; el.muted = false; }
    /* THE SOURCE IS SET BELOW, AFTER THE LISTENER. A cached file fires its
       load before a listener attached a line later can hear it, and the
       info cell is the one thing on this strip that cannot be composed
       without the file. */
    /* what actually came back, which is not always what the row asked for */
    /* A VIDEO NEVER FIRES `load`, so every clip arrived with an empty info
       cell - the one line that says what came back rather than what the row
       asked for. `loadedmetadata` is the video's equivalent, and a video's
       dimensions live on videoWidth/videoHeight, not naturalWidth. */
    el.addEventListener(el.tagName === 'VIDEO' ? 'loadedmetadata' : 'load', function () {
      if (!info) return;
      var w = el.naturalWidth || el.videoWidth, h = el.naturalHeight || el.videoHeight;
      if (!w || !h) return;
      /* IT SAYS WHICH KIND OF THING IT IS, which the strip never did - the
         numbers were there and the noun was not, and on a rung that can
         return either a frame or a clip that is the first thing to know. */
      var made = madeWith(file.saved, rung);
      info.innerHTML = '<b>' + (el.tagName === 'VIDEO' ? 'Video' : 'Image') + '</b>' +
        w + ' × ' + h + '  ·  ' + ratioName(w / h) +
        (el.duration ? '  ·  ' + el.duration.toFixed(1) + 's' : '') +
        (made ? '  ·  ' + made : '');
    });
    el.src = file.url;
    media.appendChild(el);

    /* SAVE CAME BACK, AND IT LEADS - Babe, 2026-10-26: "i guess we prob do
       still need a save image, maybe on the left of try again". It came off
       the same day on the argument that the server already writes every
       finished file under `output/`, so a download is a second copy of a
       file already on disk - true of the machine this is built on, and not
       true of anybody else's: `output/` is a folder on the server, and the
       person looking at the picture is in a browser. The review panel was
       the other half of that argument and it never offered one either, so
       `saveFile` has been unreachable since.
       IT IS THE FIRST ACTION, BECAUSE THE STRIP READS LEFT TO RIGHT and
       keeping the thing is what you do with it before deciding whether to
       keep going. CANCEL and CONTINUE JOURNEY both answer the picture; this
       one just takes it with you.
       AND THE REROLL IS GONE - Babe, 2026-10-29: "remove the rerolls on the
       modals", "should just be a save cancel or continue journey". TRY AGAIN
       was a second RUN in a panel whose job is to let you judge one result,
       and on a shared demo it is the press that spends somebody's credits
       without them going back to the rung to decide it. RUN is a foot away
       and has been the whole time.
       SO THE THREE CELLS ARE THE THREE ANSWERS TO A PICTURE: keep it, put it
       down, take it with you. Cancel is what clicking away already did, said
       out loud - which this panel needed anyway, being the one face with no
       dismiss drawn on it. */
    var buttons = [
      { label: isVideoName(file.filename) ? 'Save clip' : 'Save image',
        onClick: function () { saveFile(rung, file); } },
      { label: 'Cancel', onClick: function () { closeResult(); } }
    ];
    /* AND IT IS THE LAST RUNG THAT HAS NOWHERE TO CARRY TO, not the fifth.
       This read `rung < 5` from before the six, so 05 - a real step with 06
       in front of it - was being drawn as the end of the rail. */
    if (rung < window.HJ.slides.length) {
      buttons.push({
        label: 'Continue journey',
        primary: true,
        onClick: function () { carry(slide, rung, file); }
      });
    }
    acts(slide, buttons);

    /* AND ONLY NOW. The picture is loaded, the strip knows what it is and
       the buttons are in it, so the panel arrives finished. */
    await ready(el);
    o.classList.add('is-on');
  }

  async function run(slide) {
    var rung = rungOf(slide);
    /* 04's RUN IS THE BOARD. This rung drew it from a cell inside the
       DIRECTION panel while it also had a video job of its own to send; the
       video is 05 now, so the lit button is where every other rung's is and
       it runs the one thing this page makes. */
    if (rung === 4) {
      var panel = slide.querySelector('.slot.has-form');
      var btn = slide.querySelector('.mid-col .row > .run');
      if (panel && btn) return runBoard(panel, btn);
    }
    var o = overlayOf(slide);
    var runBtn = slide.querySelector('.mid-col .row > .run');

    /* THE MODAL ONLY OPENS ON A RESULT. While the job runs the panel stays
       readable: the rule under the prompt fills, and Run counts up. Nothing
       covers the thing you just set up. */
    o.classList.remove('is-on');
    o.querySelector('.runover-media').innerHTML = '';
    var msg = o.querySelector('.runover-msg');
    msg.textContent = '';
    msg.classList.remove('bad');
    acts(slide, []);

    /* No real progress comes back from Comfy, only a state, so the bar fills
       against the model's measured time and holds at 92% until the file is
       actually there. It never claims to be finished before it is. */
    var bar = slide.querySelector('.prog');
    var fill = bar && bar.querySelector('i');
    var eta = slide._eta || 20000;
    if (bar) bar.classList.remove('is-done');
    if (fill) fill.style.width = '0%';

    var label = runBtn ? runBtn.textContent : '';
    if (runBtn) { runBtn.disabled = true; runBtn.classList.add('is-running'); }

    var t0 = Date.now();
    var clock = setInterval(function () {
      var ms = Date.now() - t0;
      var secs = (ms / 1000).toFixed(1) + 's';
      if (runBtn) runBtn.textContent = secs;
      if (fill) fill.style.width = Math.min(92, (ms / eta) * 92).toFixed(1) + '%';
    }, 100);

    function stop(ok) {
      clearInterval(clock);
      if (runBtn) {
        runBtn.disabled = false;
        runBtn.classList.remove('is-running');
        runBtn.textContent = label;
      }
      if (bar) bar.classList.add('is-done');
      if (fill) {
        fill.style.width = ok ? '100%' : '0%';
        if (ok) setTimeout(function () { fill.style.width = '0%'; }, 1400);
      }
    }

    try {
      /* composed before the submit rather than inside it: on 02 this is where
         the layout template is drawn and uploaded, and a failure there has to
         stop the run instead of sending a sheet with no page behind it. */
      var values = await valuesFor(slide, rung);

      /* THE SHEET IS 04's SECOND REFERENCE AND IT COMES FROM TWO RUNGS BACK,
         which is further than carry() reaches - Continue journey only ever
         moves one. So 04 goes and gets it at run time instead, through the
         same /api/carry that moves an output into Comfy's input store. It is
         optional on purpose: a clip made from the hero frame alone is a
         worse clip, not a failed one, so a sheet that will not carry is
         swallowed rather than allowed to stop the run. */
      /* and the frame itself, for the same reason and by the same route */
      if (rung === 4 && !values.start && st(3).out) {
        try {
          var fres = await fetch('/api/carry', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(st(3).out)
          });
          var fjson = await fres.json();
          if (fres.ok && fjson.name) values.start = st(4).start = fjson.name;
        } catch (ignored) { /* reported below by `needs start` */ }
      }

      /* AND 05 FETCHES THE SAME FRAME, BY THE SAME ROUTE AND FOR THE SAME
         REASON. Its reference is 03's output two rungs back, which is further
         than carry() reaches. Unlike 04's sheet this one is not optional: it
         is the character, and `needs ref1` is the right refusal without it.
         THE SHEET DOES NOT FOLLOW IT HERE. SCAIL-2 takes one reference_image
         and SAM3 segments a person out of it; a four-panel sheet would be
         four people. It is on the back of the slot to be looked at, not sent. */
      /* 05 SENDS THE FACE YOU ARE ON. CHARACTER is 02's sheet and LOCATION is
         03's frame, and node 30 takes one of them - so the pressed cell picks
         the reference and an imported picture on that face outranks the rung
         it came from. Whatever it is, it arrives as `ref1`, because the graph
         has exactly one reference_image to arrive at.
         It is fetched at run time through the same /api/carry 04 uses for its
         sheet, since both rungs it draws on are further back than carry()
         reaches. Unlike 04's sheet it is not optional: `needs ref1` is the
         right refusal without it. */
      /* A BOX SHOWING A FILE FROM output/ HAS TO SEND THAT FILE. `fill` and
         the default sheet both paint from disk and mark the box with what
         they painted; nothing is uploaded until here, so a page load costs
         nothing and a run sends what you are actually looking at. */
      var bx = boxesOf(slide);
      var smap = SLOTS[rung] || {};
      var pairs = [[smap.left, bx.front[0]], [smap.right, bx.front[1]]];
      for (var pi = 0; pi < pairs.length; pi++) {
        var pk = pairs[pi][0], pb = pairs[pi][1];
        /* and a box the rail painted is not sent while it is showing words
           either - deleting it above would only have it uploaded again here. */
        if (!pk || !pb || values[pk] || !pb.dataset.fromFile) continue;
        if (pb.closest('.slot.writes.is-asking')) continue;
        /* it throws rather than running without it: a slot showing a picture
           that did not reach the model is the failure that looks like
           success, which this rail has already paid for once. */
        values[pk] = st(rung)[pk] = await uploadLocal(pb.dataset.fromFile);
      }

      /* AND THE LEFT SLOT GETS ALL THREE ANSWERS, NOT JUST THE PAINTED ONE -
         Babe, 2026-10-27, with the slate on screen and MINIMAX-H3 pressed:
         `put them in motion needs board`. The loop above is the inline copy
         this file has been promising to fold into `ensureFace` since that
         function was written, and it knows exactly one of the three routes a
         picture arrives by: a box marked `data-fromFile`. A slot showing what
         the workflow behind it made - carried in, restored from the journey,
         or painted before this sitting ever uploaded anything - has no mark
         on it at all, so the run refused for a box that was full.
         IT IS THE SAME RESOLUTION THE AGENT ALREADY USES, which is the point:
         the name if this sitting has one, else upload what the box is painted
         from, else carry what the workflow behind it made. `ensureFace` checks
         the slot's own `accept` on the way past, so the carry still cannot put
         a clip in an image loader.
         06 IS EXEMPT because its left slot is two faces and `faceRef` below
         resolves whichever one is pressed; running this first would answer
         for the face you are not on. */
      if (rung !== 6 && smap.left && !values[smap.left]) {
        try {
          var lname = await ensureLeft(slide, rung);
          if (lname) values[smap.left] = lname;
        } catch (err) { /* the server's own refusal is the honest one */ }
      }

      /* 05 SENDS BOTH FACES NOW, BECAUSE THE MODEL GREW AN INPUT.
         Every earlier row on this rung had ONE reference_image - Seedance
         edit's node 2, SCAIL-2's node 30 - so the pressed cell had to pick
         which of CHARACTER and LOCATION the run would use, and the server's
         scaffolding had to argue the other one's job out of it in words.
         `HiggsfieldMotionTransferNode` takes up to eight, so the character
         goes in as ref1 and the place as ref2 and the prompt names which is
         which. ON THAT ROW THE PRESS IS ONLY WHICH FACE YOU ARE LOOKING AT.
         A one-reference row still chooses, so the press still decides there -
         which is why this resolves a face by name rather than by position. */
      if (rung === 6) {
        var on = slide.querySelector('.tray .pick[aria-pressed="true"]');
        var isLoc = on && on.dataset.f === '1';
        /* SCAIL-2's node 30 is still a single reference_image, so that row
           still chooses. Every other row on this rung takes a list. */
        var both = modelOf(slide) !== 'SCAIL-2';

        /* ONE FACE, BY EVERY ROUTE IT CAN ARRIVE BY, in the order that puts
           what you are LOOKING AT ahead of what the rung behind you made.
           An imported picture outranks the rung it came from; a box painted
           from output/ sends that file; a frame drawn out of 04's clip has
           no file anywhere and is uploaded as the picture it is; and the
           carry is the way in for a result further back than carry() reaches.
           It returns a Comfy input name or '' - never throws, because
           `needs ref1` downstream is the honest refusal. */
        async function faceRef(loc) {
          var key = loc ? 'place' : 'ref1';
          var box = loc ? bx.alt[0] : bx.front[0];
          var madeBy = loc ? 3 : 2;
          var name = st(6)[key] || '';
          if (!name && box && box.dataset.fromFile) {
            try { name = await uploadLocal(box.dataset.fromFile); }
            catch (err) { /* the routes below are the other ways in */ }
          }
          /* A FRAME OUT OF 04's CLIP HAS NO FILE ANYWHERE - it was drawn into
             a canvas in this page - so it is uploaded as the picture it is.
             The loaders are LoadImage and 04's output is an mp4; the frame is
             how a clip rung can be a location at all.
             THE SAME FRAME, AT A SIZE WORTH SENDING: what the slot shows is
             the 320px plate, which is the room. The reference is pulled out
             of the clip again at 1280 - the identical frame of the identical
             file, the only change being how much of it there is to look at. */
          if (!name && box && box.dataset.frameOf) {
            var fr = +box.dataset.frameOf;
            var frame = await bigFrame(fr);
            if (frame) {
              try {
                name = await uploadBlob(await (await fetch(frame)).blob(),
                                        '0' + box.dataset.frameOf + '-frame.png');
              } catch (err) { /* the carry below is the other way in */ }
            }
          }
          if (!name && st(madeBy).out) {
            try {
              var rres = await fetch('/api/carry', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(st(madeBy).out)
              });
              var rjson = await rres.json();
              if (rres.ok && rjson.name) name = rjson.name;
            } catch (ignored) { /* reported by `needs ref1` */ }
          }
          return name;
        }

        if (both) {
          /* THE CHARACTER IS ALWAYS image_1 AND THE PLACE IS ALWAYS image_2,
             because the sentence names them by role and a role cannot swap
             with which cell happens to be pressed. */
          values.ref1 = await faceRef(false);
          values.ref2 = await faceRef(true);
          /* a place that never arrived drops its loader rather than refusing:
             the recast still holds, it just keeps the driving clip's room. */
          if (!values.ref2) delete values.ref2;
        } else {
          values.ref1 = await faceRef(isLoc);
          /* WHICH FACE IT IS, BECAUSE ON A ONE-REFERENCE ROW THE TWO ARE NOT
             THE SAME KIND OF PICTURE. The sheet is lit flat on grey and the
             shot is already graded, so the scaffolding asks for the look from
             one and refuses it from the other. It reaches no node - the
             server reads it to compose the sentence and patches only what
             `inputs` names. */
          values.face = isLoc ? 'location' : 'character';
        }
      }

      /* THE BOARD IS 05's FIRST REFERENCE and it is two rungs' worth of
         state away from the slot that shows it, so it is fetched at run time
         through the same /api/carry everything else uses. Unlike the sheet it
         is not optional: without it `needs board` is the right refusal. */
      if (rung === 5 && !values.board && st(4).out) {
        try {
          var bres = await fetch('/api/carry', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(st(4).out)
          });
          var bjson = await bres.json();
          if (bres.ok && bjson.name) values.board = st(5).board = bjson.name;
        } catch (ignored) { /* reported below by `needs board` */ }
      }

      if (rung === 5 && !values.sheet && st(2).out) {
        try {
          var cres = await fetch('/api/carry', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(st(2).out)
          });
          var cjson = await cres.json();
          if (cres.ok && cjson.name) values.sheet = cjson.name;
        } catch (ignored) { /* no sheet, one reference */ }
      }

      /* AND 05 PRESSES ITS OWN MODE NOW, 2026-10-29. What follows is the
         note from when it inherited one, kept because the distinction it
         draws is the reason the two facts are separate today.
         THE MODE IS THE MACHINE and the artist presses it: SINGLE SHOT
         animates the slate, SEQUENCE anchors the board's panels along the
         clip, CUSTOM conditions on the references. WHAT 04 DREW IS A
         SEPARATE FACT and rides as `slate`, because "that picture is a
         contact sheet" is a statement about what arrived and "I want cuts"
         is a statement about what to do - they were one word until this rung
         had tabs of its own.
         AND A PRESS IS VISIBLE WHERE AN INHERITANCE WAS NOT - Babe:
         "inherit from slate seems like it could be interpreted wrong no?".
         It was: a reload dropped the inherited mode, nothing on screen said
         so, and the clip came back as the grid. */
      values.slate = st(4).mode === 'sequence' ? 'board' : 'frame';

      /* AND SEQUENCE HANDS OVER THE PANELS, NOT THE PAGE. The board goes to
         the model as six pictures anchored at six frames, which is what a
         board has always meant and what `MiniMaxH3AddGuide` does - so the
         grid itself never reaches a model that would otherwise copy it.
         THE ROWS THAT DO NOT TAKE THEM IGNORE THEM: only H3's `seq` mode
         declares `panel1`..`panel6`, and a value nothing is addressed to is
         a value the patcher never looks at. Seedance and LTX go on being
         handed the slate. */
      if (rung === 5 && modeOf(slide) === 'seq') {
        var board = (boxesOf(slide).front[0] || {}).querySelector &&
                    boxesOf(slide).front[0].querySelector('img');
        var layout = modeObj('sequence');
        if (board && layout && layout.panels && layout.panels.length) {
          var cut = await cutPanels(board, layout);
          var at = anchorFrames(param(slide, 'duration'), cut.length);
          for (var pn = 0; pn < cut.length; pn++) {
            values['panel' + (pn + 1)] = cut[pn];
            values['at' + (pn + 1)] = at[pn];
          }
        }
      }

      /* 05 INHERITS THE MODE IT IS SHOOTING. The kind of shot was chosen on
         04, where the board was drawn from it, so this rung asks the rung
         behind it rather than anything on its own page.
         AND IT ASKS OUTRIGHT NOW, not as a fallback. This read 05's own slot
         first and only fell through to 04 when nothing answered - which held
         for exactly as long as 05 had no tabs. Its box is a form as of
         2026-10-27, so `modeOf` answers `take`, and `SHOOT_SYS` would have
         stopped being told that the picture in front of it is a contact
         sheet: a grid handed to a video model with no word about it comes
         back as a grid, which this rail has paid for on 03 and again on 05's
         first board. THE WORD MEANS TWO DIFFERENT THINGS ON THE TWO RUNGS -
         on 04 it is the job, here it is only which form you are filling in -
         and the one the server reads is 04's. */
      var job = await submitAndWait(
        { rung: rung, model: modelOf(slide),
          mode: modeOf(slide),
          raw: rawOf(slide), values: values },
        function (sub) {
          var seedCell = slide.querySelector('.param[data-p="seed"]');
          if (seedCell && seedCell.dataset.lock !== '1' && sub.seed !== undefined) {
            seedCell.querySelector('b').textContent = String(sub.seed);
          }
        });

      stop(job.ok);

      if (!job.ok) {
        say(slide, job.error || 'the job failed', true);
        acts(slide, []);
        return;
      }

      var file = job.outputs && job.outputs[0];
      if (!file) {
        say(slide, 'finished with no file', true);
        acts(slide, []);
        return;
      }

      /* a result is not a look and not the band: every opener names the
         face it wants, because the closer tidies on a timer and cannot know
         what is about to want the panel. */
      /* THE PANEL GOES ON SCREEN AT THE BOTTOM OF THIS BLOCK, NOT HERE - see
         `ready`. Everything between is work the panel has to have done before
         it is worth looking at, and `plateFromClip` is awaited, so a clip
         used to leave an empty panel standing for as long as a frame took to
         pull out of it. */
      await showResult(slide, rung, file);

    } catch (err) {
      stop(false);
      say(slide, String(err.message || err), true);
      acts(slide, []);
    }
  }

  /* SUBMIT, THEN WAIT, IN ONE PLACE. A finished job's results only appear on
     the detail endpoint, so every job is two steps - and a rung and a reading
     both take them. A second copy of the poll is a second thing to get
     wrong. */
  async function submitAndWait(body, onSeed) {
    var res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    var sub = await res.json();
    if (!res.ok) throw new Error(sub.error || 'submit failed');
    if (onSeed) onSeed(sub);
    return await new Promise(function (resolve, reject) {
      var tick = setInterval(async function () {
        try {
          var r = await fetch('/api/job/' + sub.jobId);
          var j = await r.json();
          if (!r.ok) throw new Error(j.error || 'status failed');
          if (j.done) { clearInterval(tick); resolve(j); }
        } catch (e) { clearInterval(tick); reject(e); }
      }, 2000);
    });
  }

  /* ------------------------------------------------- reading the character */

  /* AUTO. The nine fields are a draft to correct rather than a form to fill,
     so a model with eyes writes the first version. The question is built from
     the same TRAITS table the card is built from, so a field added to the
     table is a field asked for - there is no second list to forget.

     IT ONLY EVER FILLS WHAT IT WAS ASKED FOR and only keys it recognises, so
     a model that invents a tenth field changes nothing on the card. */
  function traitQuestion() {
    /* AND THE SECOND HALF IS NO LONGER "JUDGE IT FROM HOW THEY LOOK". That
       was written for nine traits, four of which the picture genuinely shows;
       those four are gone - the model reading them is looking at the picture -
       and what is left is the half a still frame cannot settle. Asking how
       somebody SOUNDS by how they look is the question answering itself. */
    var want = (window.HJ.traits || []).map(function (t) {
      return '"' + t.k + '": ' + t.n.toLowerCase() +
             (t.vis ? ' (the picture shows this)'
                    : ' (the picture cannot show this - infer it from them)');
    });
    return 'Look at this character and answer with a JSON object holding exactly ' +
           'these keys: ' + want.join(', ') + '.';
  }

  /* THE AGENT, AT LAST - Babe, 2026-10-26: "can we wire up the llm to help
     with a style prompt". The panel has been real since 04 grew it and the
     endpoint was the one thing missing; this is the whole of it.
     THE TRANSCRIPT IS THE PROMPT. A chat model is sent what has been said so
     far, and the panel already holds it in the DOM - speaker as a heading
     over the line - so the conversation is read off the thing you are looking
     at rather than kept a second time in a variable that could drift from it.
     IT LIVES HERE AND THE PAGE CALLS IT. `mockup.html` binds to its own
     elements and never fetches; the seam it left for this is one function. */
  function transcript(log) {
    var out = [];
    [].slice.call(log.querySelectorAll('.msg-k')).forEach(function (k) {
      var line = k.nextElementSibling;
      if (!line || line.classList.contains('pending')) return;
      /* a note is the panel reporting what it did, not something anybody
         said - sending it back would have the model reading its own proposal
         as a second turn of its own. */
      if (k.classList.contains('note')) return;
      /* THE MODEL IS `You` AND THE ARTIST IS `Person`. The panel labels them
         the other way round because it is written for the person reading it;
         a transcript handed to the model has to be written for the model, or
         it reads its own lines as somebody else's. */
      var who = k.textContent.trim().toLowerCase() === 'you' ? 'Person' : 'You';
      var said = line.textContent.trim();
      if (said) out.push(who + ': ' + said);
    });
    return out.join('\n');
  }

  /* WHICH QUESTION THE AGENT IS BEING ASKED. The panel is one panel and the
     subject is not: 01 is writing a style, 03 a place, 04 a shot. It rides in
     as `about` and reaches no node - the server picks the scaffolding from it
     the way it picks one from `lens` or `face`. An unlisted rung falls back
     to the style half on the server rather than being refused here. */
  var HELP_ABOUT = { 1: 'style', 3: 'place', 4: 'shot', 5: 'motion', 6: 'change' };

  /* AND ON 04 THE QUESTION IS THE TAB'S, NOT THE RUNG'S - Babe, 2026-10-26:
     "i think the agent should have context when doing a board of 6 frames".
     It was answering BOARD with a single framing - "a wide, low-angle shot
     looking up through the deep blue water" - which is a perfect answer to
     the other tab. A board is six framings of one scene, so naming one is
     spending the whole direction on a sixth of the page, and the layout
     already names the six. The mode is the job on this rung, the way it is
     for the run itself. */
  function helpAbout(slot) {
    var rung = rungOf(slot.closest('.slide'));
    if (rung === 4 && slot.dataset.mode === 'sequence') return 'board';
    /* AND 05's SEQUENCE IS ITS OWN CONVERSATION, 2026-10-29. The panels are
       anchored along the clip on that tab, so the shots exist before a word
       is written - which is the opposite of what `motion` asks for, where
       how many shots there are is the artist's decision and the agent is
       told six panels are not six shots. Same picture, two jobs. */
    if (rung === 5 && slot.dataset.mode === 'seq') return 'shots';
    /* AND ON 01 THE SAME WAY. STYLE writes a character and EDIT changes one
       thing in a picture - two jobs, one slot - and the tab is the only
       thing that knows which. It is scoped to this rung because 06 has an
       EDIT tab of its own and that one is a clip being edited, which is
       `change` and a different conversation. */
    if (rung === 1 && String(slot.dataset.mode || '').toUpperCase() === 'EDIT') return 'edit';
    return HELP_ABOUT[rung] || 'style';
  }

  /* THE SIX, BY NAME, OFF THE TABLE THE TEMPLATE IS DRAWN FROM - Babe,
     2026-10-26: "so the prompt can be more structure for 6 frames in a grid".
     The agent writing for a grid has to know what is in it, and the one
     description of that anywhere is `MODES`: the picker draws from it, the
     page the model is handed is drawn from it, and the panel sentence is
     composed from it. A second list of panel names here is a list that can
     disagree with the drawing. It rides along as a value and reaches no
     node, the way `about` and `lens` already do. */
  function panelNames(slot) {
    var mode = modeObj(slot.dataset.mode);
    if (!mode || !mode.panels || mode.panels.length < 2) return '';
    return mode.panels.map(function (p) {
      return [].concat(p.label || []).join(' ');
    }).join(', ');
  }

  /* AND IT LOOKS AT WHAT THE RUNG IS HOLDING - Babe, 2026-10-26: "so when
     you use the agent it will have access to look at the slate right?". It
     did not: the chat graph was the traits machine minus the image, so the
     agent was writing about a shot it had never seen - worst on 05, where
     what moves depends entirely on what is in the frame.
     IT IS THE LEFT SLOT, WHICH IS ONE CALL AND NOT A RULE PER RUNG. The left
     is what you have and the right is what you choose, and this panel helps
     you write the right-hand one about the left-hand one - so `ensureLeft`
     is already the whole question, and it is the same resolution RUN uses:
     the input name if this sitting has one, else upload what the box is
     painted from, else carry what the rung behind it made.
     A FAILURE HERE IS NOT A FAILURE OF THE CONVERSATION. An empty slot, a
     carry Comfy has evicted, a rung with nothing behind it - the picture is
     simply absent, the server drops the loader and the paragraph naming it,
     and the agent answers the way it did yesterday. Being unable to see is
     not a reason to refuse to talk. */
  window.HJ.agentAsk = async function (slot, log) {
    var slide = slot.closest('.slide');
    var rung = rungOf(slide);
    var look = '';
    try { look = await ensureLeft(slide, rung) || ''; } catch (err) { look = ''; }
    var job = await submitAndWait({
      rung: 'agent',
      values: {
        prompt: transcript(log),
        about: helpAbout(slot),
        /* AND WHICH MODEL THE LINE IS GOING TO - Babe, 2026-10-27: "the
           context should change based on the model / workflow and the agent
           should have that context change". The agent has been writing the
           same register of sentence whichever row is pressed, and the rows do
           not read alike: nano takes a system prompt and follows
           instructions, qwen has no such input and runs at CFG 1 with the
           scaffolding joined to the front, where length costs steering.
           IT IS THE ROW THAT IS PRESSED, read the same way RUN reads it, so
           the line is written for the model that will actually receive it. */
        model: modelOf(slide),
        panels: panelNames(slot),
        look: look,
        /* AND HOW LONG THE CLIP IS, OFF THE ROW THAT SETS IT - Babe,
           2026-10-26: "based on duration it needs to know how many shots are
           possible". The agent was writing a paragraph that could have been
           three seconds or fifteen for a row that says five, because the one
           place the length is decided is the cell under the panel and nothing
           carried it. It rides along and reaches no node, the way `panels`
           does; only 05 has the cell, and a rung without one leaves it at the
           server's floor. */
        /* AND IT IS THE SAME NUMBER THE RUN WILL SEND, which `parseInt` was
           not: on 06 the cell is the clip's own length and the run rounds it
           (`6.9s` goes as 7), while this truncated to 6 - so the plan was
           written to a second that the clip would not have. A timeline that
           ends before the footage does is the summarising this exists to
           stop. */
        seconds: Math.round(parseFloat(param(slide, 'duration')) || 0)
      }
    });
    if (!job.ok) throw new Error(job.error || 'the agent did not answer');
    var said = (job.text || [])[0];
    if (!said) throw new Error('it came back with nothing to say');
    var out = parseTraits(said);
    var line = String(out.prompt || '').trim();
    return {
      say: String(out.say || '').trim() || line || 'nothing came back',
      /* ONLY A REAL LINE ARMS THE RUNG. An empty string is the agent saying
         it is still asking, and `answered` reads exactly that. */
      prompt: line
    };
  };

  /* a model asked for JSON will still fence it about half the time */
  function parseTraits(text) {
    var raw = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '');
    var i = raw.indexOf('{'), j = raw.lastIndexOf('}');
    if (i < 0 || j < i) throw new Error('no JSON in the answer');
    return JSON.parse(raw.slice(i, j + 1));
  }

  /* THE SERVER'S WORDS ARE NOT THE PERSON'S WORDS. `unknown rung traits` is
     true and useless: it means this page is newer than the server it is
     talking to. The raw line still goes to the console for whoever is
     debugging; what lands on the card is what to do about it. */
  function niceError(err) {
    var m = String((err && err.message) || err || '');
    if (m) console.warn('traits:', m);
    /* IT ANSWERS TO BOTH WORDS, which is this message's own subject: the page
       may be talking to an older server, and that one says `rung`. */
    if (/unknown (rung|workflow)/i.test(m)) return 'the server is older than this page \u2014 restart it';
    if (/nothing in the slot/i.test(m)) return 'there is no character in the slot yet';
    if (/no JSON|nothing to say|none of the fields/i.test(m)) return 'it could not read the picture \u2014 try again';
    /* a node that threw is a node that threw, wherever it was asked from -
       and this card runs a graph of its own, so it can see one too. It is
       asked before the catch-all below, which would otherwise swallow it. */
    var p = plainly(m);
    if (p !== m) return p;
    if (/failed|error/i.test(m) && m.length > 48) return 'the reading failed';
    return m;
  }

  /* a failed read says so inside the card, on its own line, and the line stays
     until the card is opened again - a message that vanishes is a message you
     did not read. */
  function cardSays(slot, text) {
    var el = slot && slot.querySelector('.card-msg');
    if (el) el.textContent = text || '';
  }

  /* A PAINTED SLOT IS NOT AN UPLOADED ONE, AND EVERY JOB HAS TO KNOW THAT.
     `fill()` paints a box from `output/` and marks it `data-fromFile` rather
     than spending five uploads on a page load, and a restored journey may
     hold only the rung behind this one's output - so a slot can be showing
     exactly the right picture while `st(rung)[key]` is still empty. AUTO read
     that as an empty slot and said so over a hero that was on screen the
     whole time. Babe, 2026-10-26: "i hit auto and it said there is no
     character in the slot yet".
     IT IS THE THIRD COPY OF THIS, so it is a function now: `run()` has one
     inline and `runBoard` had another, which is where this was lifted from. */
  /* AND IT RESOLVES THE FACE THAT IS UP - Babe, 2026-10-29, with a character
     imported onto 06's SCENE face and the agent asking him to describe it:
     "it would be amazing if the agent could see what you have loaded. like
     when using swap for example". It could not: this took the FRONT box and
     the front key, so on a flipped slot it asked the empty face, got nothing,
     and `AGENT_SEES` dropped out - the blind agent, politely asking about a
     picture six inches to its left. The same mistake the X made an hour ago,
     in the one other place that had not asked which box is showing.
     THE FRONT IS THE FALLBACK, NOT THE ANSWER. On 04 and 05 both faces
     travel and the front one is the job's own subject, so a visible face with
     nothing in it must not shadow it. Ask the face you are looking at; if it
     is empty, ask the one the rung is about. */
  async function ensureLeft(slide, rung) {
    var b = boxesOf(slide);
    var spec = SLOTS[rung] || {};
    var slot = b.front[0] && b.front[0].closest('.slot');
    var up = slot && slot.classList.contains('is-flipped') && b.alt[0] && spec.alt;
    if (up) {
      var shown = await ensureFace(slide, rung, spec.alt, b.alt[0], st(rung - 1).out);
      if (shown) return shown;
    }
    return ensureFace(slide, rung, spec.left, b.front[0], st(rung - 1).out);
  }

  /* THE SAME THREE ANSWERS, FOR EITHER FACE OF A TWO-FACED SLOT: the input
     name if this sitting has one, else upload whatever the box is painted
     from, else carry what the rung it comes from made. `ensureLeft` was this
     with the front box and the rung behind written in. */
  async function ensureFace(slide, rung, key, box, made) {
    /* AND A NAME ALREADY WRITTEN DOWN IS CHECKED THE SAME WAY, because the
       journey is where the last bad hand-off is still sitting: 06 held an
       mp4 on its character face and would have sent it again on every press
       until somebody emptied the slot by hand. */
    var have = st(rung)[key];
    if (have && box && !wantsVideo(box) && isVideoName(have)) {
      delete st(rung)[key];
      if (st(rung).urls) delete st(rung).urls[key];
      saveJourney();
      have = '';
    }
    if (have) return have;
    if (box && box.dataset.fromFile && !(!wantsVideo(box) && isVideoName(box.dataset.fromFile))) {
      /* AND WHAT IT IS SHOWING IS WRITTEN DOWN WITH WHAT IT IS SENDING -
         Babe, 2026-10-27: "idk why the hero is lost now". 06's character face
         had a name and no url: a run resolved it by uploading the file the
         box was painted from, wrote the Comfy input name into the journey,
         and recorded nothing about the picture. On the next load the state
         said the face was full, so `paintSheetFace` left it alone, and there
         was nothing to draw - a slot claiming to hold something and showing
         an empty box, which is the one lie this rail cannot afford.
         THE FILE IT WAS PAINTED FROM IS THE ANSWER and it is right here. */
      var name = await uploadLocal(box.dataset.fromFile);
      st(rung)[key] = name;
      noteSlot(rung, key, '/' + String(box.dataset.fromFile).replace(/^\//, ''),
               isVideoName(box.dataset.fromFile));
      return name;
    }
    /* AND A FACE WILL NOT TAKE A FILE ITS SLOT CANNOT HOLD - Babe, 2026-10-27,
       on a failed 06: "i wonder if its because of the api tho". It was not.
       The executed graph came back with `LoadImage { image: "….mp4" }`: the
       character face was empty, so this fell through to carrying what the
       workflow behind it made, and 05 makes a clip. This file wrote the
       hazard down the day the carry was built - "any automatic hand-off has
       to check the next slot's `accept` or it will quietly put a clip in an
       image slot" - and then the hand-off was built without the check.
       THE BOX ALREADY KNOWS: its file chooser says what it takes. A refusal
       here reads as `needs ref1`, which is true and fixable; a video on a
       LoadImage reads as whatever the far end feels like saying. */
    var prev = made;
    if (prev && box && !wantsVideo(box) && isVideoName(prev.filename || prev.saved || '')) {
      prev = null;
    }
    if (prev) {
      var res = await fetch('/api/carry', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prev)
      });
      var json = await res.json();
      if (res.ok && json.name) {
        st(rung)[key] = json.name;
        saveJourney();
        return json.name;
      }
    }
    return '';
  }

  async function readTraits(slide, rung, cell) {
    var slot = cell.closest('.slot');
    var name;
    try { name = await ensureLeft(slide, rung); }
    catch (err) { return cardSays(slot, niceError(err)); }
    if (!name) return cardSays(slot, 'there is no character in the slot yet');

    var was = cell.textContent;
    cell.disabled = true;
    cell.textContent = 'Scanning';
    cardSays(slot, '');
    slot.classList.add('is-working');
    try {
      var job = await submitAndWait({
        rung: 'traits',
        values: { figure: name, prompt: traitQuestion() }
      });
      if (!job.ok) throw new Error(job.error || 'the reading failed');
      var said = (job.text || [])[0];
      if (!said) throw new Error('it came back with nothing to say');

      var got = parseTraits(said);
      var filled = 0;
      (window.HJ.traits || []).forEach(function (t) {
        var v = got[t.k];
        if (typeof v !== 'string' || !v.trim()) return;
        var el = slide.querySelector('.tf[data-t="' + t.k + '"]');
        if (!el) return;
        el.textContent = v.trim();
        filled++;
      });
      if (!filled) throw new Error('none of the fields came back');
      saveJourney();
    } catch (err) {
      cardSays(slot, niceError(err));
    } finally {
      slot.classList.remove('is-working');
      cell.disabled = false;
      cell.textContent = was;
    }
  }

  /* ----------------------------------------------- carrying it to the next */

  /* NO RUNG MESSAGING. Continuing said "carrying into rung 03…" over the
     result you were looking at, which is the app narrating its own plumbing:
     the word rung is not on screen anywhere else, and the travel already
     says where you went. Only a failure speaks now. */
  /* HOW LONG CONTINUE JOURNEY HOLDS ON THE ROOM IT JUST MADE, measured from
     the press. The modal is out at 150ms and the planes are sharp at 170ms,
     so everything after that is the look. This is the number to turn. */
  var BEAT = 1000;

  /* WHAT A RUNG MADE BECOMES THAT RUNG'S ROOM - WHEN SOMEBODY ACCEPTS IT.
     Babe, 2026-10-26: "it looks like the background changed before the modal
     popped up. continue journey should prob trigger the background change".
     It always did change first; it was just invisible while the panel opened
     in the same frame, and the panel waiting for its picture is what made the
     old order show.
     AND IT IS THE RULE THIS RAIL ALREADY RUNS ON, arriving at the plate. A
     result on screen is a proposal and Continue journey is the acceptance -
     which is why the next rung's slot does not fill itself either. Press TRY
     AGAIN and the room is still the one you had, rather than already being
     the thing you just rejected.
     AND THE BEAT BELOW IS WHAT IT IS FOR. The plate is set, then the modal
     closes, then 480ms, then the travel - so the room you just made is
     revealed by the panel leaving and is on screen by itself before anything
     moves. That beat existed for exactly this and had nothing new to show.
     A CLIP DRESSES ITS SECTION IN ONE OF ITS OWN FRAMES. A video cannot be a
     CSS plate, which is why 04 and 05 could never have a room. */
  async function dressRung(rung, file) {
    /* AND IT STANDS IN THE COPY WE OWN, NOT THE PROXY. `file.url` is
       /api/file, which reads straight out of Comfy and only works for as
       long as Comfy keeps the file; `output/` is ours and is written before
       the poll is answered. The room drawn on screen and the room written
       into the journey are now the same string, so a plate cannot go black
       under you while the drawer still claims it is there. */
    var lasting = lastingUrl(file) || file.url;
    if (!isVideoName(file.filename)) {
      if (wearsRoom(rung) && window.HJ.setVoid) window.HJ.setVoid(lasting, rung - 1);
    } else {
      await plateFromClip(lasting, rung, !wearsRoom(rung));
    }
    /* and every section after this one is now standing in front of one more
       room than it was a moment ago. */
    dressCollages();
    /* WRITTEN DOWN AS A ROOM, NOT AS AN OUTPUT, so a reload cannot put back a
       plate nobody accepted. A clip is remembered by the clip - the frame is
       pulled out again on the way back in, because the journey holds names
       and urls and never pictures. */
    st(rung).room = lasting;
    saveJourney();
  }

  async function carry(slide, rung, file) {
    try {
      /* a staged file was uploaded straight into Comfy's input folder, so
         there is nothing to copy across */
      var out = { name: file.inputName };
      if (!out.name) {
        var res = await fetch('/api/carry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(file)
        });
        out = await res.json();
        if (!res.ok) throw new Error(out.error || 'carry failed');
      }

      var next = window.HJ.slides[rung];           // rung is 1-based, slides 0-based
      /* AND ONLY INTO A SLOT THAT TAKES THIS KIND OF FILE. This file has
         warned since the carry was built that an automatic hand-off has to
         check the next slot's `accept` or it will quietly put a clip in an
         image slot - and 05 to 06 is where it finally did: Babe, 2026-10-28,
         looking at the transition, found 06's HERO wearing a frame of the 05
         clip under CHARACTER, where the sheet belongs.
         IT CARRIES NOTHING RATHER THAN CARRYING IT SOMEWHERE ELSE. The right
         slot does accept video on 06 - but LEFT IS INHERITED AND RIGHT IS
         CHOSEN is the rule the whole panel runs on, and the driving clip is
         the one input this file says is BROUGHT, not picked. So a result the
         next left slot cannot hold is a result that stays where it was made;
         the travel still happens and the room is still dressed, because
         Continue journey is the acceptance of the PICTURE, not a promise
         that the next rung wanted it. */
      var map = SLOTS[rung + 1] || {};
      var key = map.left;
      var vid = isVideoName(file.filename);
      var takes = String((map.accept && map.accept.left) || '');
      if (key && (!takes || takes.indexOf(vid ? 'video' : 'image') > -1)) {
        st(rung + 1)[key] = out.name;
        /* BY SLOT, NEVER BY POSITION. `querySelectorAll('.drop')[0]` held
           while a slide had one box per slot and this was the last place
           still reading it - a left slot with a second face puts its alt box
           between the two slots in the DOM. */
        var box = boxesOf(next).front[0];
        /* AND A CARRIED RESULT IS A NEW CHARACTER TOO. 01 hands 02 a figure
           it has never seen; the card below it may still be describing the
           last one, and `features` travels from here to the end of the rail.
           Same call as the import path, for the same reason. */
        if (box) staleTraits(box);
        if (box) showMedia(box, file.url, vid);
        noteSlot(rung + 1, key, lastingUrl(file), vid);
      }

      /* A SECTION'S ROOM IS WHAT IT MADE, AND ONLY THAT. Carrying used to dress
         the next slide with the thing it was handed, which put 01's figure
         behind 02 and made 02 read as 01's room with a different headline.
         Babe, 2026-10-24: "02 is showing 01 now... it should show 02 but only
         after you generate it". An empty section stays the empty stage.
         WHAT CARRIES CONTINUITY IS THE TRAVEL, NOT THE PLATE: at VOID TRAVEL
         40% the room you just left is still a third of the frame on the left
         when you arrive, which is "we should see 01 on the left side of 02"
         and it needs nothing drawn behind 02 to happen. */

      /* A BEAT BETWEEN CLOSING AND LEAVING. Pressing Continue used to shut the
         modal and start the travel in the same frame, so the room you just
         made was never once on screen on its own - you went from looking at
         the picture to looking at the next section. Babe, 2026-10-24: "if it
         closes the modal first for a beat and then transitions so you do have
         a chance to see the background".
         AND THE BEAT IS THE LOOKING, NOT THE CLOSING. At 480 the modal and the
         rack back ate more than a third of it and what was left read as a
         stutter rather than a pause - Babe, 2026-10-24: "lets still have more
         of a beat when you continue journey so its not close and move so
         quick". */
      /* THE ROOM CHANGES UNDER THE PANEL, so the panel leaving is what reveals
         it. Before the close, not after, or the plate swaps in open air. */
      await dressRung(rung, file);
      closeResult();
      await new Promise(function (r) { setTimeout(r, BEAT); });
      window.HJ.go(rung);                          // 0-based index of the next slide
    } catch (err) {
      say(slide, String(err.message || err), true);
    }
  }

  /* ----------------------------------------------------------------- bind */

  /* CLICK OFF TO CLOSE. The result has no dismiss button, so anywhere that
     is not the panel closes it, and so does Escape. */
  /* AND THE RACK BACK IS QUICK. `.cam:has(.runover.is-on) .plane` stops
     matching the instant the panel closes, so the return is governed by the
     plane's own filter transition - which is --plane-fade, the 1300ms a
     neighbouring slide takes to come into focus across a travel. Right here
     that is slow. The camera wears `is-racking` for the length of the rack
     and nothing else changes. */
  var facing = null;
  var racking = null;
  /* the button in the bar. It is bound here rather than in mockup.html
     because everything it needs - the overlay, peek and the acts row - lives
     in this file. */
  (function () {
    var btn = document.getElementById('shots');
    if (btn) btn.addEventListener('click', function () { shots(); });
    var k = document.getElementById('keybtn');
    if (k) k.addEventListener('click', function () { keyPanel(); });
  })();

  /* ------------------------------------------------------------- the key */
  /* ANYBODY WHO INSTALLS THIS HAS A COMFY KEY AND NOWHERE TO PUT IT, and
     "make a file called .env" is the whole install for most people. So the
     bar has a button and this is the form behind it.
     THE PAGE IS A FORM, THE SERVER IS THE KEEPER. The key goes over once,
     the server writes .env and never sends it back, and /api/health goes on
     answering `set` or `MISSING` and nothing else - so the state in the bar
     is read off the one thing that has the key rather than off anything the
     browser remembers. */
  var KEY_STATE = 'unknown';

  function markKey(state) {
    KEY_STATE = state;
    var btn = document.getElementById('keybtn');
    if (btn) btn.classList.toggle('is-missing', state !== 'set');
  }

  /* WHAT THIS MODE DOES TO YOUR FOOTAGE, IN THE BOX YOU ARE WRITING IN -
     Babe, 2026-10-27: "can we add the help into the actual panel as like a
     toggle. so its per mode in the prompt sections of that mode". The first
     version opened the result overlay with all four modes in it, which dimmed
     the whole rail to answer a question about the sentence under your cursor
     and made you read three answers to find yours.
     IT IS NOT A PROMPTING GUIDE, AND THAT IS WHAT EARNS IT A PLACE. The
     server's scaffolding handles the mechanics for everyone whatever they
     type, and the agent already reads the pressed tab, so the only thing left
     for this to do is say which machine the sentence is going into. Neither
     of the other two can know what you MEANT - which is how a mouse held to a
     mouth survived EDIT and became a regulator under RESHOOT.
     ONE MODE, THE ONE YOU ARE ON, because the tabs are a foot away and the
     question this answers is about the box you are in.
     IT STANDS ON THE WRITING FACE'S OWN PLATE, the way the agent panel and
     the traits card do, so nothing new is invented for it to sit on. */
  function whyOff(slot) {
    slot.classList.remove('is-why');
    /* wherever it was hung - the box on a mode note, the stage on a box one */
    var old = slot.querySelector('.whybox');
    if (old) old.remove();
    var cell = slot.querySelector('.tr.why');
    if (cell) cell.setAttribute('aria-pressed', 'false');
  }

  /* AND THE FACE IS ASKED BEFORE THE MODE - Babe, 2026-10-29: "the ? needs
     to talk about the boxes feature". The question this cell answers is
     "what does the thing in front of me do", and inside the box face the
     thing in front of you is the box face, not the tab two rows up. Same
     shape as `openAsk` reading the pressed tab's `ask` before the slide's:
     the nearer question wins.
     AND THE NOTE NEEDS SOMEWHERE VISIBLE TO STAND. It hosts in `.drop`,
     which the box face hides - so a note hung there would have been drawn
     into a box nobody can see, which is why the cell was hidden rather than
     answered in the first draft. The stage is the visible surface there. */
  function whyBits(slot) {
    if (slot.classList.contains('is-boxing') && slot.dataset.boxes) {
      return { n: 'Boxes', why: slot.dataset.boxes,
               host: slot.querySelector('.boxer-stage') };
    }
    var rows = window.HJ.modeHelp ? window.HJ.modeHelp(slot) : [];
    var now = (slot.dataset.mode || '').toUpperCase();
    var mine = rows.find(function (r) { return String(r.k).toUpperCase() === now; })
            || rows[0];
    /* AND A SLOT WITH NO TABS ANSWERS FOR ITSELF - Babe, 2026-10-29, on 03:
       "for consistency we should add the ? next to the prompt for this as
       well". Every note until now hung off a MODE, because every slot that
       had one had tabs; this slot has one face, so the string is the slot's
       and the name is read off the strip it is already drawn in rather than
       emitted a second time. The mode is still asked first, since a slot
       that has both has a nearer question. */
    /* AND THE NOTE HANGS WHERE THE FACE YOU ARE IN CAN SHOW IT - Babe,
       2026-10-29: "if you have agent enabled and press help it doesnt
       appear". It did not: `.slot.is-agent .drop { display: none }` takes
       the writing box away, so the note was being drawn into a box nobody
       could see - the same thing the box face found and answered by hanging
       its own on the stage.
       AND THE RULE THAT WAS MEANT TO STOP THAT HAD BEEN DEAD SINCE IT WAS
       WRITTEN. `.slot.is-agent .tr.why` is four classes and the rule that
       shows the cell, `.slot.is-asking.writes .tr.why`, is five - so on
       every writing slot on the rail the cell has been pressable in the
       agent face the whole time, doing nothing, while a comment beside it
       said it was not drawn there. A press that reaches a cell is a press
       that has to be answered: the panel is the visible surface, so that is
       where it goes, and the hiding rule is deleted rather than given
       another class to win with. */
    /* AND A FORM SLOT HAS NO `.drop` AT ALL, which is the same fallback
       `facePlate` makes for the same reason: on 04 the face you are standing
       in is the `.writer`, so that is the surface the note covers. */
    var host = slot.classList.contains('is-agent')
      ? slot.querySelector('.helper')
      : (slot.querySelector('.drop') || slot.querySelector('.writer'));
    if (!mine || !mine.why) {
      if (!slot.dataset.why) return null;
      var k = slot.querySelector('.ftab-k');
      return { n: (k && k.textContent.trim()) || slot.dataset.face0 || 'Prompt',
               why: slot.dataset.why, host: host, sends: true };
    }
    return { n: mine.n || mine.k, why: mine.why, host: host, sends: true };
  }

  function toggleWhy(slot) {
    if (slot.classList.contains('is-why')) return whyOff(slot);
    var mine = whyBits(slot);
    if (!mine) return;
    var box = mine.host;
    if (!box) return;
    var el = document.createElement('div');
    el.className = 'whybox';
    var b = document.createElement('b');
    b.textContent = mine.n;
    var t = document.createElement('span');
    t.textContent = mine.why;
    el.appendChild(b);
    el.appendChild(t);
    /* AND WHAT ACTUALLY GOES, if the slot says. It is read off the slot
       rather than off the mode because the payload is the same whichever tab
       is pressed - see `sends` in the slide table. A slot that does not
       declare one simply has no line, the way a mode without `why` has no
       cell. */
    if (mine.sends && slot.dataset.sends) {
      var how = document.createElement('div');
      how.className = 'whyhow';
      slot.dataset.sends.split('|').forEach(function (one) {
        var line = document.createElement('i');
        line.textContent = one;
        how.appendChild(line);
      });
      el.appendChild(how);
    }
    box.appendChild(el);
    slot.classList.add('is-why');
    var cell = slot.querySelector('.tr.why');
    if (cell) cell.setAttribute('aria-pressed', 'true');
  }

  /* AND A MODE PRESS TAKES THE NOTE DOWN, because the note is ABOUT the mode
     and the press is how you leave one. Measured in the page: pressing EDIT
     with the note up left `Reshoot` standing over an EDIT box, which is the
     same lie as a slot showing a picture the model never got. It is its own
     listener rather than a line inside the tab handler because the tab
     handler lives in the page and this is the only thing here that cares;
     capture, so it does not depend on which of the two runs first. */
  document.addEventListener('click', function (e) {
    var tab = e.target.closest && e.target.closest('.ftabs .ftab, .tabs .tab');
    if (!tab) return;
    var slot = tab.closest('.slot');
    if (slot && slot.classList.contains('is-why')) whyOff(slot);
  }, true);

  /* delegated, like the speaker: the tray is rebuilt and round-tripped
     through its own markup, and a bound listener does not survive that. */
  document.addEventListener('click', function (e) {
    var cell = e.target.closest && e.target.closest('.tr.why');
    if (!cell) return;
    e.stopPropagation();
    e.preventDefault();
    var slot = cell.closest('.slot');
    if (slot) toggleWhy(slot);
  }, true);

  function keyPanel(slide) {
    slide = slide || window.HJ.slides[window.HJ.index()];
    var o = overlayOf(slide);
    o.classList.add('is-on', 'is-key');
    o.classList.remove('is-peek', 'is-shots', 'has-back');
    var msg = o.querySelector('.runover-msg');
    msg.className = 'runover-msg';
    msg.textContent = '';

    var media = o.querySelector('.runover-media');
    media.innerHTML = '';
    var form = document.createElement('div');
    form.className = 'keyform';

    var head = document.createElement('div');
    head.className = 'key-head';
    head.textContent = 'Comfy API key';   /* Babe's */

    var p = document.createElement('p');
    /* WHERE TO GET ONE IS HALF THE ANSWER. The key is shown once on Comfy's
       side and never again, which is worth saying here rather than being
       found out by going back to look for it. */
    /* BABE'S, 2026-10-29, WORD FOR WORD. It replaced a sentence of mine that
       explained what Comfy Cloud is, what credits are and that the key is
       shown once - three facts, where the person reading this needs one
       instruction and a door. THE LINK IS THE DEEP ONE and it is its own
       text: a URL you can read is a URL you can check before you click it,
       and `.keyform p` is selectable so it can be copied rather than typed.
       A `Comfy Cloud` link to comfy.org/cloud went in an hour earlier and
       came out with the reword, which no longer names it. */
    p.innerHTML = 'Hero&rsquo;s Journey requires a Comfy API key. Create one now at ' +
      '<a href="https://platform.comfy.org/profile/api-keys" target="_blank" rel="noreferrer">' +
      'https://platform.comfy.org/profile/api-keys</a>' +
      ' and paste it into the textbox below.';
    var input = document.createElement('input');
    /* A PASSWORD FIELD BECAUSE THIS SCREEN GETS RECORDED. The whole reason
       this panel exists is that other people are going to run this, which
       means demos and screen shares - and a key in a video frame is a key
       somebody has to go and revoke. The field is the one place it could be
       read off the page. */
    input.type = 'password';
    input.autocomplete = 'off';
    input.spellcheck = false;
    /* WHAT IT SAYS DEPENDS ON WHETHER THERE IS ONE. (*) `comfyui***` is
       Babe's. It is masked rather than real - the server never sends a key
       back, so nothing here could show the true one even if it should. */
    var had = KEY_STATE === 'set';
    input.placeholder = had ? 'comfyui***' : 'comfyui-…';
    if (had) input.classList.add('is-set');
    input.setAttribute('aria-label', 'Comfy API key');

    /* THE BUTTON IS THE PAGE'S ONE RED ACTION BUTTON, not a fifth drawing of
       one - same class as RUN, so it is the same height as the field beside
       it by construction rather than by a number written down here. */
    var save = document.createElement('button');
    save.className = 'run';
    save.type = 'button';
    save.textContent = 'SAVE KEY';   /* (*) Babe said "unlock"; this is mine */

    var row = document.createElement('div');
    row.className = 'keyrow';
    row.appendChild(input);
    row.appendChild(save);

    form.appendChild(head);
    form.appendChild(p);
    form.appendChild(row);
    media.appendChild(form);

    var saving = false;
    /* `submit`, NOT `save` - the button is called save and a function of the
       same name would shadow it inside this scope. That is the bug that once
       made every error path on 04 call a DOM element and throw on its way to
       reporting what went wrong. */
    async function submit() {
      if (saving) return;
      var v = input.value.trim();
      if (!v) { msg.className = 'runover-msg bad'; msg.textContent = 'paste the key first'; return; }
      saving = true;
      save.disabled = true;
      msg.className = 'runover-msg';
      /* EVERY STATE SAYS ITSELF ON ONE LINE NOW. It was split between here and
         the foot's info cell, which is two places for one answer. */
      msg.textContent = 'asking Comfy…';
      try {
        var r = await fetch('/api/key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: v })
        });
        var j = await r.json().catch(function () { return {}; });
        if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
        /* THE FIELD IS EMPTIED THE MOMENT IT IS KEPT. There is nothing left
           to do with it here and a box still holding a credential is a box
           that can be read over somebody's shoulder. */
        input.value = '';
        /* AND THE EMPTIED BOX HAS TO SAY WHY IT IS EMPTY - Babe, 2026-10-29,
           on a successful save: "it looks like this like you need to paste it
           in again and save". The field is cleared the moment the key is kept
           and the ask came back with it, so a panel that had just succeeded
           read as one waiting to be used. The masked placeholder was chosen
           at OPEN, which is right for a panel you open with a key already in
           place and says nothing about one that has just been given one. */
        input.placeholder = 'comfyui***';
        input.classList.add('is-set');
        markKey('set');
        msg.textContent = 'Saved · ' + (j.chars || '?') + ' characters. Every workflow can run now.';
        /* AND THE ROW HAS TO HEAR ABOUT IT, because Run has been cold since
           boot for exactly this reason. One health call, the same one boot
           makes, rather than a second opinion about what is wired. */
        health();
        /* AND THEN IT GETS OUT OF THE WAY - Babe, 2026-10-29: "a user
           already reads it so yeah, when you save it should prob just
           close". This panel is the one face on the rail with a hidden foot,
           so after a save there is nothing left to press and the only way
           out is a click on something that is not it. A beat first, long
           enough for `Saved` to register, and the bar's key going quiet is
           the confirmation that stays.
           ONLY ON A SAVE: a refusal keeps the panel, because the panel is
           where the sentence about it is. And only if the key face is still
           the one up - you can click away or open something else inside the
           beat, and closing then would take whatever that is with it. */
        setTimeout(function () {
          if (o.classList.contains('is-on') && o.classList.contains('is-key')) closeResult();
        }, 900);
      } catch (e) {
        msg.className = 'runover-msg bad';
        msg.textContent = niceError(e && e.message || String(e));
      }
      saving = false;
      save.disabled = false;
    }

    save.addEventListener('click', submit);
    /* the foot is hidden on this face, and an empty row is what the next
       thing to open this panel inherits if it is not cleared */
    acts(slide, []);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
    setTimeout(function () { input.focus(); }, 40);
  }

  /* ONE HEALTH CALL, CALLED FROM TWO PLACES. Boot asks, and saving a key
     asks again - a second copy of this would be a second chance to disagree
     with the server about what is wired. */
  function health() {
    return fetch('/api/health').then(function (r) { return r.json(); }).then(function (h) {
      markKey(h.key === 'set' ? 'set' : 'missing');
      markWired(h.wired);
      /* A COLD INSTALL IS ASKED, NOT LEFT TO NOTICE - Babe, 2026-10-27: "prob
         just a small modal that popsup to unlock it". Nothing on the rail can
         run without a key, so this is not one answer among several being put
         in front of the other two: it is the only thing there is to do, and a
         red glyph in the corner is a quiet way to say so to somebody who has
         never seen this page. THE RULE IT LOOKS LIKE IT BREAKS is 01's
         opening prompt panel, which was built and reverted because a box
         already being typed in hid IMPORT and RANDOM - "this forces them to
         get used to using the bottom panel". A precondition hides nothing.
         ONCE A LOAD, AND NEVER WITH A KEY. The red key stays as the way back
         in, and the panel closes on Escape or a click outside like every
         other, so looking around first is still allowed. */
      if (h.key !== 'set') afterIntro(offerKey);
    }).catch(function () {});
  }

  /* IT WAITS FOR THE PAGE TO FINISH ARRIVING. The opening cascade plays once
     a load and a modal over a half-revealed rail is the ending shown before
     the beginning - the same reason the page waits hidden rather than
     painting and snapping to zero. */
  var introOver = false, waiting = [];
  document.addEventListener('hj:intro', function () {
    introOver = true;
    waiting.splice(0).forEach(function (fn) { fn(); });
  });
  function afterIntro(fn) {
    if (introOver) fn(); else waiting.push(fn);
  }
  /* AND IT ASKS ANYWAY IF THE PAGE NEVER SAYS SO, which mirrors the page's own
     `setTimeout(intro, 2500)`: an install that cannot be unlocked because an
     animation did not report is worse than a panel arriving over a cascade. */
  setTimeout(function () {
    if (!introOver) document.dispatchEvent(new CustomEvent('hj:intro'));
  }, 4000);

  var asked = false;
  function offerKey() {
    if (asked || KEY_STATE === 'set') return;
    asked = true;
    keyPanel();
  }

  /* the undo, until the panel has somewhere to put one on screen */
  window.HJ.unhide = function () {
    try { localStorage.removeItem(HIDDEN_KEY); } catch (e) {}
    /* both drawers, because the undo has to answer for both kinds of putting
       away or it is an undo that lies about what it undid. */
    try { localStorage.removeItem(HIDDEN_SESSIONS); } catch (e) {}
    var open = document.querySelector('.runover.is-on.is-shots');
    if (open) shots(open.closest('.slide'));
  };

  function closeResult() {
    var open = document.querySelector('.runover.is-on');
    if (!open) return;
    /* A HIDDEN VIDEO IS STILL PLAYING. The panel arrives and leaves rather
       than appearing, so it is never `display: none` - `visibility` is what
       takes it out of reach, and visibility stops you seeing a clip without
       stopping it. Babe, 2026-10-25: "i closed it and still heard the audio
       after it was closed". Every way out of the panel comes through here -
       the click outside, Escape, and Cancel - so pausing here covers all
       three. The element is rebuilt on the next open, so there is nothing to
       rewind. */
    open.querySelectorAll('video').forEach(function (v) { v.pause(); });
    /* THE FACE OUTLIVES THE CLOSE BY AS LONG AS THE EXIT TAKES. A class left
       on is a state the next open inherits, so it still has to go - but
       stripping it in the same frame the fade starts took the review panel's
       own transform off mid-exit, and a full-screen band snapped back to
       scale(.965) on its way out. Babe, 2026-10-25: "kind of looks like a
       glitch when you press it on and off".
       The exit is 120ms of fade against 150ms of transform, so 220 is clear
       of both, and the guard is there because you can open it again inside
       that window. */
    open.classList.remove('is-on');
    clearTimeout(facing);
    facing = setTimeout(function () {
      if (!open.classList.contains('is-on')) {
        open.classList.remove('is-shots', 'has-back', 'is-peek', 'is-key');
      }
    }, 220);
    /* and the button that opened it comes back up with it */
    var trig = document.getElementById('shots');
    if (trig) trig.setAttribute('aria-pressed', 'false');
    var cam = document.querySelector('.cam');
    if (!cam) return;
    cam.classList.add('is-racking');
    clearTimeout(racking);
    racking = setTimeout(function () { cam.classList.remove('is-racking'); }, 260);
  }
  document.addEventListener('mousedown', function (e) {
    if (!document.querySelector('.runover.is-on')) return;
    if (e.target.closest && e.target.closest('.runover')) return;
    closeResult();
    /* THE CLICK THAT DISMISSES A PANEL IS NOT A CLICK ON WHAT WAS BEHIND IT.
       The panel closes on mousedown; the click that follows lands on whatever
       was underneath, and underneath is usually a slot - so putting the big
       view down opened a file chooser. Swallow exactly the next click. */
    window.addEventListener('click', function (ev) {
      ev.stopPropagation();
      ev.preventDefault();
    }, { capture: true, once: true });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeResult();
  });

  /* THE PICTURE IS THE PLAY BUTTON - Babe, 2026-10-26: "can we make it so
     you can click on the video to pause/play it". A clip in the big view had
     native controls and a clip in a slot had nothing at all, so the one
     gesture everybody tries was the one thing neither of them answered.
     IT IS AN ALLOWLIST OF TWO PARENTS, not a list of videos to leave alone.
     Three of the <video> elements on this page are not a clip you are
     watching - a live webcam preview, the blurred plate behind a writing box
     or an agent panel, and a thumbnail inside a strip cell - and naming the
     two boxes where a clip is being WATCHED cannot be wrong about any of
     them the way a list of exceptions can. The webcam still needs its own
     test, because it lives in one of those two boxes: pausing a stream would
     take CAPTURE's frame away with it.
     AND THE NATIVE CONTROL BAR IS NOT THE PICTURE. A press on its own PAUSE
     is a click on the <video> as far as this handler can see, so without the
     bottom strip it would pause and then be played again by this. */
  document.addEventListener('click', function (e) {
    var v = e.target.closest && e.target.closest('video');
    if (!v || v.srcObject) return;
    var box = v.parentNode;
    if (!box || !box.classList) return;
    var big = box.classList.contains('runover-media');
    if (!big && !(box.classList.contains('drop') && !box.classList.contains('is-ask'))) return;
    if (big && v.controls && e.offsetY > v.clientHeight - 44) return;
    if (v.paused) v.play().catch(function () {}); else v.pause();
  });

  window.HJ.slides.forEach(function (slide) {
    var rung = rungOf(slide);
    var map = SLOTS[rung];
    var boxes = boxesOf(slide);

    if (boxes.front[0] && map.left) {
      bindSlot(boxes.front[0], rung, map.left, map.accept.left, boxes.alt[0], map.alt);
    }
    if (boxes.front[1] && map.right) bindSlot(boxes.front[1], rung, map.right, map.accept.right);

    /* A words slot has a tray too. Rewrite belongs to the agent, which does
       not exist yet, so it says so instead of pretending. */
    var sayEl = slide.querySelector('.say');
    if (sayEl) {
      var sayTray = sayEl.parentNode.querySelector('.tray');
      var clear = sayTray && sayTray.querySelector('[data-act="clear"]');
      if (clear) clear.addEventListener('click', function () { sayEl.textContent = ''; sayEl.focus(); });
      var rew = sayTray && sayTray.querySelector('[data-act="rewrite"]');
      /* AND NOT ON A DEAD ONE EITHER. A disabled button is already saying
         it cannot be pressed, and most browsers will not show a tooltip on
         one anyway - so this was a sentence nobody could read explaining a
         cell nobody can press. (*) If REWRITE is never going to be wired,
         the cell should come off the row rather than sit there dimmed. */
      if (rew) rew.disabled = true;
    }

    var runBtn = slide.querySelector('.mid-col .row > .run');
    if (runBtn && !WIRED[rung]) {
      runBtn.disabled = true;
      runBtn.textContent = 'Not wired';
    } else if (runBtn) {
      bindRun(slide, runBtn);
    }
  });

  /* THE SERVER DECIDES WHICH ROWS ARE LIVE. It reports the model names it has
     a graph for, per rung, so the menu can grey out the rest instead of
     failing at the press — and so adding a graph needs no change here. It
     overwrites the guess above; this is not a second variable. */

  /* THE ROW SHOWS WHAT THE CHOSEN MODEL ACTUALLY TAKES. The server reports
     the cells each model understands, so STEPS disappears beside a model
     with no step count and AR disappears beside one whose output just
     follows the source. A control that does nothing is worse than no
     control. */
  function markParams(slide, applyDefaults) {
    var live = WIRED[rungOf(slide)];
    var spec = live && live[modelOf(slide)];
    var allow = spec && spec.params;
    var defs = (spec && spec.defaults) || {};
    slide.querySelectorAll('.param[data-p]').forEach(function (cell) {
      var key = cell.dataset.p;
      /* A READOUT IS NOT A CONTROL, SO THE MODEL'S LIST DOES NOT GOVERN IT.
         `params` is what the chosen model TAKES; DURATION is a fact about
         what will come out, derived from the clip in the slot, and it reaches
         no node by design. It stays. */
      var ok = cell.dataset.read === '1' || !allow || allow.indexOf(key) !== -1;
      cell.style.display = ok ? '' : 'none';
      /* THE ROW FOLLOWS THE MODEL. Carrying the last one's numbers across is
         how a turbo checkpoint ended up being run at 25 steps. */
      /* THE CELL'S OPTIONS BELONG TO THE MODEL TOO. A cycle walks
         `data-o`, so a row whose vocabulary differs rewrites that list
         rather than hiding a control it genuinely takes. The cell is
         re-measured after, because its width is sized in ch to the widest
         option it can hold and THE PARAM ROW NEVER MOVES. */
      var owns = (spec && spec.options && spec.options[key]) || null;
      if (owns && cell.dataset.o !== owns.join('|')) {
        cell.dataset.o = owns.join('|');
        var now = cell.querySelector('b').textContent;
        if (owns.indexOf(now) === -1) {
          cell.querySelector('b').textContent = owns[0];
          if (cell.dataset.v !== undefined) cell.dataset.v = owns[0];
        }
        /* the width is an inline ch on the <b>, computed at render from the
           option list - so a new list recomputes it the same way. */
        var b = cell.querySelector('b');
        b.style.width = Math.max.apply(null, owns.map(function (o) { return o.length; })) + 'ch';
      }
      if (!applyDefaults || !ok) return;
      var want = defs[key];
      if (want === undefined || key === 'seed') return;
      var opts = (cell.dataset.o || '').split('|');
      if (opts.indexOf(String(want)) === -1) return;
      cell.querySelector('b').textContent = String(want);
      /* and an icon cell follows its value here too, for the same reason it
         does on a click: the glyph is drawn from `data-v`. */
      if (cell.dataset.v !== undefined) cell.dataset.v = String(want);
    });
  }

  /* THE RUN LISTENER IS BOUND ONCE, BY WHICHEVER OF THE TWO GETS THERE
     FIRST - Babe, 2026-10-27: "also the modal pops up twice". It was two
     jobs, not two panels: `output/session04/01/` holds four Klein files in
     two pairs six seconds apart with different seeds, which is one press
     submitting twice.
     TWO PLACES BOUND IT AND ONLY ONE REMEMBERED. The slot loop binds against
     the `WIRED` first guess - the literal that exists so Run does not flash
     "Not wired" on every load - and then /api/health arrives and `markWired`
     binds again, because the guard it carries was written on the assumption
     that it was the only binder. Both are right to want Run live; neither
     needs to know about the other.
     AND IT IS A GUARD RATHER THAN A DELETION, because the early binding is
     what makes the button honest when there is no server to answer health:
     dropping it would leave a lit RUN with nothing behind it, which is the
     one thing this rail must never draw. */
  function bindRun(slide, btn) {
    if (!btn || btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', function () { run(slide); });
  }

  /* THE NAME OFF A MENU ROW, WITHOUT THE RECEIPT WORD AFTER IT. Two readers
     ask this now and a row's label is drawn in one place, so it is read in
     one place too. */
  function rowName(row) {
    return (row.querySelector('span') || row).textContent
      .replace(/\s*\((local|partner)\)\s*$/, '').trim();
  }

  /* A ROW THAT DOES ONE JOB ONLY APPEARS WHERE THAT JOB IS - Babe,
     2026-10-27, on FLUX-3-KLEIN handing back the photograph it was given:
     "i dont think edit is the right workflow for this. maybe it should only
     appear when you are in the edit tab".
     `only` HAS PINNED THE MODE ON THE SERVER SINCE SCAIL-2, so that a tab
     could not promise a job the graph has no way to do - but it could not
     say so on the picker, so the row sat on every tab and the refusal
     arrived as a result that looked like it had worked. /api/health carries
     it now, which is the trip `params`, `options` and `defaults` already
     make.
     AND A ROW THAT GOES MUST NOT STAY PRESSED. The press is what writes the
     label on the trigger and the receipt under the panel, so stepping back
     is a press on the first row still standing rather than a second place
     that knows how to set those two. */
  function markOnly(slide, mode) {
    var menu = slide.querySelector('.model-menu');
    if (!menu) return;
    var live = WIRED[rungOf(slide)] || {};
    var now = String(mode || modeOf(slide) || '').toUpperCase();
    var rows = [].slice.call(menu.querySelectorAll('.mm'));
    var fell = false;
    rows.forEach(function (row) {
      var only = (live[rowName(row)] || {}).only;
      var off = !!only && String(only).toUpperCase() !== now;
      row.classList.toggle('off', off);
      if (off && row.getAttribute('aria-pressed') === 'true') fell = true;
    });
    /* AND `solo` IS PER TAB, BECAUSE A ROW CAN BELONG TO A MODE. The trigger
       was drawn solo from the rung's whole list (`models.length < 2`), which
       held for exactly as long as every row on a rung was usable by every
       tab. 01 has two rows and FLUX-3-KLEIN is `only: "EDIT"`, so STYLE has
       ONE row it can use and a caret that opened a menu with nothing in it -
       a pressed row and an `off` row are both `display: none`, so the box is
       empty rather than short. The count to watch is per tab, not per rung,
       which this picker's own rule already says one level in.
       IT IS COUNTED HERE BECAUSE THIS IS THE FUNCTION THAT KNOWS - the
       `only` of every row, the wired state and the pressed one, all three in
       one walk. A second count anywhere else is a second thing to disagree.
       USABLE, NOT UNPRESSED: a press moves a row out of the menu but does
       not change how many this tab can reach, so the test cannot depend on
       which row is pressed or on the order the clicks below land in. It also
       covers a rung whose one alternative is not wired. */
    var usable = rows.filter(function (r) {
      return !r.classList.contains('off') && !r.disabled;
    }).length;
    var trig = slide.querySelector('.param.model');
    if (trig) trig.classList.toggle('solo', usable < 2);
    if (!fell) return;
    /* AND IT GOES BACK TO WHAT YOU PICKED, NOT TO THE TOP OF THE LIST - Babe,
       2026-10-27, after a run they thought was on an open row: "when i went
       back to the workflow tho nano was selected". Stepping off a hidden row
       landed on the FIRST row, which on every rung is the partner default -
       so a look at the other tab and back silently moved the job onto the
       one row that costs real money, and the only thing that said so was a
       label nobody was looking at. A press is remembered per mode and handed
       back when that mode comes round again; the first legal row is what
       happens when you have never picked one. */
    var want = (slide._pickedBy || {})[now];
    var open = rows.filter(function (r) {
      return !r.classList.contains('off') && !r.disabled;
    });
    for (var i = 0; i < open.length; i++) {
      if (want && rowName(open[i]) === want) return open[i].click();
    }
    if (open.length) return open[0].click();
  }

  /* WHICH ROW A PERSON PICKED, PER MODE, AND `isTrusted` IS THE WHOLE TEST.
     A press by a person is a choice and is remembered; the press `markOnly`
     makes to step off a hidden row is the page tidying up after itself, and
     remembering that one would overwrite the choice this exists to give
     back. The browser draws that line for us and nothing else here has to. */
  document.addEventListener('click', function (e) {
    if (!e.isTrusted) return;
    var mm = e.target.closest && e.target.closest('.model-menu .mm');
    if (!mm || mm.disabled) return;
    var slide = mm.closest('.slide');
    if (!slide) return;
    var mode = String(modeOf(slide) || '').toUpperCase();
    (slide._pickedBy || (slide._pickedBy = {}))[mode] = rowName(mm);
    st(rungOf(slide)).model = rowName(mm);
    saveJourney();
  }, true);

  /* AND THE CONVERSATION BELONGS TO THE MODE IT WAS HAD IN - Babe,
     2026-10-27, on an EDIT answer that came back as a whole new character
     line: "i think it took the instructions wrong... it should have just
     been something like the character is holding test tubes containing a
     glowing red liquid or something. but it added 3d render again". The
     panel is one panel and the modes are two jobs, so the STYLE conversation
     - three turns of it, ending in a full 3D-rendering proposal - was still
     on screen and still being sent when the EDIT turn went out. THE
     TRANSCRIPT IS THE PROMPT, read off the panel, so a conversation about
     what to BECOME is a worked example of exactly the wrong shape in front
     of a question about what to CHANGE.
     IT IS THE RULE THE WRITING BOX ALREADY FOLLOWS: `data-said` keeps each
     mode's sentence and hands it back, and this keeps each mode's turns the
     same way - as nodes, so a pending answer still lands in the turn that
     asked for it and is waiting there when you come back.
     AND THE SEED IS THE OPENING LINE AS IT WAS BUILT, cloned, so a mode you
     have never opened starts on the question its slot declares rather than
     on somebody else's answer. */
  function swapLog(slot, to) {
    var log = slot && slot.querySelector('.helper-log');
    if (!log) return;
    var from = String(slot.dataset.mode || '').toUpperCase();
    to = String(to || '').toUpperCase();
    if (!from || !to || from === to) return;
    var mem = slot._logs || (slot._logs = {});
    if (!mem._seed) {
      mem._seed = document.createDocumentFragment();
      [].slice.call(log.children, 0, 2).forEach(function (n) {
        mem._seed.appendChild(n.cloneNode(true));
      });
    }
    var keep = document.createDocumentFragment();
    while (log.firstChild) keep.appendChild(log.firstChild);
    mem[from] = keep;
    /* AND A MODE THAT DECLARES ITS OWN OPENING LINE OPENS ON IT. The seed is
       the slot's question, which is one question for every job the tabs
       offer; `data-help` is a mode saying the agent should ask its own, the
       way `data-ask` is a mode saying the BOX should. Written into the clone
       rather than into the panel, so it is only ever the first thing in a
       conversation nobody has had yet - a mode you have talked to comes back
       with its own turns, which is what `mem[to]` is. */
    var fresh = mem[to];
    if (!fresh) {
      fresh = mem._seed.cloneNode(true);
      var tab = slot.querySelector('.ftab[data-mode="' + to + '"]');
      var mine = tab && tab.dataset.help;
      var line = mine && fresh.querySelector && fresh.querySelector('.msg');
      if (line) line.innerHTML = mine;
    }
    log.appendChild(fresh);
    log.scrollTop = log.scrollHeight;
  }

  /* IT RUNS BEFORE THE PAGE'S OWN HANDLER, because that one writes
     `slot.dataset.mode` and this has to read the mode you are LEAVING. */
  document.addEventListener('click', function (e) {
    var tab = e.target.closest && e.target.closest('.ftabs .ftab');
    if (!tab) return;
    swapLog(tab.closest('.slot'), tab.dataset.mode);
  }, true);

  /* AND THE PICKER FOLLOWS THE TAB. It reads the pressed tab's own
     `data-mode` rather than the slot's, because the page's handler writes
     the slot a moment later and two listeners agreeing about which of them
     runs first is a thing that only has to be got wrong once. */
  document.addEventListener('click', function (e) {
    var tab = e.target.closest && e.target.closest('.ftabs .ftab');
    if (!tab) return;
    var slide = tab.closest('.slide');
    if (slide) markOnly(slide, tab.dataset.mode);
  });

  function markWired(wired) {
    WIRED = wired || {};
    window.HJ.slides.forEach(function (slide) {
      var rung = rungOf(slide);
      var live = Object.keys((wired && wired[rung]) || {});
      slide.querySelectorAll('.model-menu .mm').forEach(function (row) {
        var name = rowName(row);
        var ok = live.indexOf(name) !== -1;
        row.disabled = !ok;
        /* the row is dimmed and unpickable, which is the whole message - it
           used to also say so in a column that no longer exists. */
        row.style.opacity = ok ? '' : '.4';
      });
      /* BEFORE `markOnly`, so a row pinned to another mode is stepped off
         by the one function that knows how rather than left pressed. It is
         a press and not a label write: `faceModel` was a second mechanism
         for keeping a label honest and this file has paid for it once. */
      var want = st(rung).model;
      if (want) {
        slide.querySelectorAll('.model-menu .mm').forEach(function (row) {
          if (!row.disabled && rowName(row) === want &&
              row.getAttribute('aria-pressed') !== 'true') row.click();
        });
        /* AND THE TWO MEMORIES AGREE. `_pickedBy` is what a mode switch
           hands back and the drawer is what a reload hands back; seeding one
           from the other means a restored row survives a look at the other
           tab instead of falling to the top of the list the first time. */
        (slide._pickedBy || (slide._pickedBy = {}))[
          String(modeOf(slide) || '').toUpperCase()] = want;
      }
      markParams(slide, true);
      markOnly(slide);
      markFaces(slide);
      /* A LIT BUTTON THAT CANNOT RUN IS THE ONE THING THIS RAIL MUST NEVER
         DRAW, and with no key none of them can. The two refusals are not the
         same refusal: a rung with no graph behind the chosen row is Not
         wired and always will be, and a rung with no key is one paste away -
         which is what the red key in the bar is for.
         (*) `No key` is mine and it is Babe's to rewrite.
         THE LISTENER IS BOUND ONCE AND REMEMBERS IT. It used to be attached
         on the way through the label, which held while this ran once at
         boot; saving a key runs it again, and a second listener on Run is a
         second job submitted by one press. */
      var runBtn = slide.querySelector('.mid-col .row > .run');
      if (runBtn) {
        var ready = live.length && KEY_STATE === 'set';
        if (ready) bindRun(slide, runBtn);
        runBtn.textContent = ready ? 'Run' : (live.length ? 'No key' : 'Not wired');
        runBtn.disabled = !ready;
      }
    });
  }

  /* THE CARD AND THE PICKER ARE WORK TOO. Nine fields somebody typed and the
     layout they chose are as much a part of the journey as the pictures. */
  var cardPending = null;
  document.addEventListener('input', function (e) {
    if (!e.target.closest || !e.target.closest('.card')) return;
    clearTimeout(cardPending);
    cardPending = setTimeout(saveJourney, 400);
  });
  document.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('.tray .sheet')) setTimeout(saveJourney, 0);
  });

  /* A FACE THE CHOSEN ROW CANNOT BE HANDED IS NOT A FACE. `takes` is the
     model's own input table, read off /api/health the same trip `params`
     and `defaults` make, and the slot's second key is in `SLOTS`, so
     nothing new is written down.
     IT IS SCOPED TO `data-view`, WHICH IS THE CELL THAT WAS ALREADY SAYING
     THIS PAIR IS A LOOK RATHER THAN A CHOICE. On 04 and 05 both faces
     travel, so one the model has no address for is simply not in the job;
     on 06 the pressed cell IS the reference the graph takes, and SCAIL-2
     resolves it by name through `faceRef` rather than by key - hiding a
     cell there would take the choice away instead of telling the truth
     about it.
     AND AN OLDER SERVER SAYS NOTHING, so a page talking to one shows every
     face exactly as before rather than hiding them all. */
  function markFaces(slide) {
    var live = (WIRED[rungOf(slide)] || {})[modelOf(slide)] || {};
    if (!live.takes) return;
    var alt = (SLOTS[rungOf(slide)] || {}).alt;
    var off = !!alt && live.takes.indexOf(alt) === -1;
    slide.querySelectorAll('.tr.pick[data-view="1"][data-f="1"]').forEach(function (cell) {
      cell.classList.toggle('off', off);
      if (!off || cell.getAttribute('aria-pressed') !== 'true') return;
      var first = cell.parentNode.querySelector('.tr.pick[data-f="0"]');
      if (first) first.click();
    });
  }

  document.addEventListener('click', function (e) {
    var mm = e.target.closest && e.target.closest('.mm');
    if (!mm) return;
    var slide = mm.closest('.slide');
    /* after the page's own handler has moved the label on the trigger */
    if (slide) setTimeout(function () { markParams(slide, true); markFaces(slide); }, 0);
  });

  /* DEV: draw and upload a layout template without running anything, which is
     the only way to see that the page the model will be handed really exists
     in Comfy's input folder. `HJ.template(HJ.sheets[0], 1736, 1152)` returns
     the name it was stored under, or throws the way a run would. */
  window.HJ.template = templateFor;

  /* DEV: stage a finished result from something already in output/, so the
     flow after a rung — Continue journey, the carry, the next rung's held
     slot — can be worked on without paying for a rung. Press S, or call
     HJ.stage('output/…/file.png') for a particular one. */
  window.HJ.stage = async function (path) {
    var slide = window.HJ.slides[window.HJ.index()];
    var rung = rungOf(slide);
    try {
      if (!path) {
        var list = await (await fetch('/api/output')).json();
        var files = list.files || [];
        /* THE NEWEST FILE IS NOT NECESSARILY THIS RUNG'S. The listing sorts by
           path, so once 02 has made a sheet it sorts above everything 01 ever
           made, and pressing S on 01 staged the sheet - 01 ended up standing
           in 02's room. Take this rung's own folder first. */
        var mine = files.filter(function (f) {
          return inSession(f) && f.indexOf('/0' + rung + '/') > -1 && madeHere(f);
        });
        /* AND IT NEVER FALLS BACK TO ANOTHER RUNG'S. Taking this rung's folder
           first was half the fix; the `|| files[0]` under it was the other
           half of the bug - on a rung that has made nothing, S staged the
           newest thing on the rail, so pressing it on 05 opened 04's clip.
           Babe, 2026-10-25: "s just wants to view the video again and this
           section is different". A rung with no output has nothing to stage
           and should say so. */
        path = mine[0];
        if (!path) throw new Error('0' + rung + ' has not made anything yet');
      }
      var blob = await (await fetch('/' + path)).blob();
      var up = await fetch('/api/upload?name=' + encodeURIComponent(path.split('/').pop()), {
        method: 'POST', headers: { 'Content-Type': blob.type || 'image/png' }, body: blob
      });
      var got = await up.json();
      if (!up.ok) throw new Error(got.error || 'upload failed');

      var file = { filename: path.split('/').pop(), subfolder: '', type: 'output',
                   url: '/' + path, inputName: got.name };
      st(rung).out = file;
      /* A STAGED FILE ON A RUNG THAT DRAWS A BOARD IS THE BOARD - Babe,
         2026-10-25: "i want to run this image so can we get it to show as the
         result", "in the direction panel". `S` exists so the next step can be
         worked on without paying for the one before it, and on 04 the next
         step is the motion run, which needs a board in the panel and a name
         in Comfy's input folder. `stage` has already uploaded the file, so
         both are one assignment away - without them the panel stayed empty
         and the rung's RUN stayed cold on a rung that had a picture. */
      var board = slide.querySelector('.slot.has-form .boardbox');
      if (board) {
        showMedia(board, file.url, isVideoName(file.filename));
        var bslot = board.closest('.slot');
        bslot.classList.remove('is-editing');
        bslot.classList.add('has-board');
        if (window.HJ.boardHead) window.HJ.boardHead(bslot, false);
        st(rung).board = got.name;
      }
      /* S STAGES A RESULT AS IF THE WHOLE THING HAD HAPPENED, acceptance and
         all - it exists so the carry and the next rung's slot can be worked
         on without paying for a rung - so it writes the room down as well as
         putting it up, or a reload would take back half of what it staged. */
      st(rung).room = lastingUrl(file) || file.url;
      saveJourney();
      paintSheetFace();
      /* AND A CLIP IS NOT A PLATE HERE EITHER. The run path and `dress` both
         learned this - `--void-src` is a CSS background and a video in one
         draws nothing - and staging was the third plate path, still handing a
         .mp4 to `setVoid`. So a staged 05 had no room AND no `st(5).plate`,
         which is what the ending reads when the output it wants is a clip:
         06's collage went looking for the swimming shot and found the last
         thing that had left one lying about. It takes `lastingUrl` too, which
         is the string the line above it just wrote the room down as. */
      var staged = lastingUrl(file) || file.url;
      if (!isVideoName(file.filename)) {
        if (wearsRoom(rung) && window.HJ.setVoid) window.HJ.setVoid(staged, rung - 1);
      } else {
        await plateFromClip(staged, rung, !wearsRoom(rung));
      }
      /* and the ending is one room richer than it was, the way a real run
         leaves it - staging exists so the rung after can be worked on. */
      dressCollages();

      var o = overlayOf(slide);
      /* a result is not a look and not the band: every opener names the
         face it wants, because the closer tidies on a timer and cannot know
         what is about to want the panel. */
      o.classList.remove('is-peek', 'is-shots', 'has-back', 'is-key');
      o.classList.add('is-on');
      var media = o.querySelector('.runover-media');
      media.innerHTML = '';
      var info = o.querySelector('.info');
      if (info) info.textContent = '';
      var el = document.createElement(isVideoName(file.filename) ? 'video' : 'img');
      el.src = file.url;
      if (el.tagName === 'VIDEO') { el.controls = true; el.loop = true; el.playsInline = true; el.autoplay = true; }
      el.addEventListener(el.tagName === 'VIDEO' ? 'loadedmetadata' : 'load', function () {
        var w = el.naturalWidth || el.videoWidth, h = el.naturalHeight || el.videoHeight;
        if (info && w) {
          info.innerHTML = '<b>' + (el.tagName === 'VIDEO' ? 'Video' : 'Image') + '</b>' +
            w + ' × ' + h + '  ·  ' + ratioName(w / h) + '  ·  staged';
        }
      });
      media.appendChild(el);

      /* THE SAME THREE ANSWERS AS A REAL RESULT - see the foot above. A
         staged one is a picture to judge like any other, and leaving the
         reroll here would make this the only panel on the rail still
         offering it. */
      var buttons = [{ label: 'Cancel', onClick: function () { closeResult(); } }];
      if (rung < window.HJ.slides.length) buttons.push({ label: 'Continue journey',
        primary: true, onClick: function () { carry(slide, rung, file); } });
      acts(slide, buttons);
      return path;
    } catch (err) {
      say(slide, String(err.message || err), true);
    }
  };

  /* DRESS THE WHOLE RAIL FROM WHAT IS ALREADY ON DISK - Babe, 2026-10-25:
     "can you just set it so its easy to adjust the final design once
     everything is populated". Tuning the plate set against one populated
     section and four empty ones is guessing: the mask, the past-room ghost
     and the travel only disagree with each other when there is a room on
     either side of you. `S` stages one rung and spends nothing; this is that
     for all five at once, and it spends nothing either.
     IT SETS PLATES, NOT STATE. Nothing is written to storage and no slot is
     filled - it dresses the rail for looking at and a reload puts it back the
     way it really is, so a tuning session can never be mistaken for progress
     through the journey.
     AND `quiet` IS THE SAME WALK WITHOUT THE ROOMS - see the call in
     `fill`. It still pulls a frame out of a clip rung, because that frame is
     what 05's LOCATION face is painted from and what the collage is made of;
     what it does not do is decide where a section is standing. */
  window.HJ.dress = async function (opts) {
    var quiet = !!(opts && opts.quiet);
    var list = await (await fetch('/api/output')).json();
    var files = list.files || [];
    var done = [];
    for (var r = 1; r <= window.HJ.slides.length; r++) {
      /* newest first: /api/output sorts by path and reverses, and the path
         starts with the day and the time. */
      var mine = files.filter(function (f) {
        return inSession(f) && f.indexOf('/0' + r + '/') > -1 && madeHere(f);
      });
      if (!mine.length || !window.HJ.setVoid) continue;
      /* A CLIP IS NOT A PLATE. `--void-src` is a CSS background and a video
         in one draws nothing, so a rung that outputs clips was being dressed
         with an empty room and no sign of it. It wears its own frames
         instead, which is the only kind of room 04 and 05 can have. */
      if (isVideoName(mine[0])) {
        await plateFromClip('/' + mine[0], r, quiet || !wearsRoom(r));
        done.push(r + ' <- 4 frames of ' + mine[0].split('/').pop());
        continue;
      }
      if (quiet || !wearsRoom(r)) continue;
      window.HJ.setVoid('/' + mine[0], r - 1);
      done.push(r + ' <- ' + mine[0].split('/').pop());
    }
    console.log(done.length ? done.join('\n') : 'nothing in output/ to dress with');
    return done.length;
  };

  /* DEV: WALK THE WHOLE FLOW WITHOUT PAYING FOR ANY OF IT - Babe,
     2026-10-25: "lets populate all this so we can go through the flow".
     `dress` puts a room behind each section; this fills the slots in front of
     them, which is the other half of the same wish. Every rung's left slot
     takes the newest thing the rung behind it made, which is the carry rule
     written out, and the two-faced slots take theirs from the table that
     already says which rungs they wear.
     IT MARKS EACH BOX WITH THE FILE IT IS SHOWING rather than uploading
     anything: a page load should not cost five uploads, and the run already
     knows how to put a local file where Comfy can reach it. */
  window.HJ.fill = async function () {
    var done = [];

    for (var r = 1; r <= window.HJ.slides.length; r++) {
      /* AND IT DOES NOT OVERWRITE A RECORD THE JOURNEY ALREADY HAS. `fill`
         says of itself that every fill checks that slot's own state first -
         and this loop, the only one above the slots, did not. So a rail that
         had been dressed deliberately came back from a reload with each
         workflow's `out` replaced by the NEWEST file in its folder, which on
         a session holding more than one walk is a different character. The
         rooms survived, because nothing here touches `room` - so the plates
         were right and the ENDING was wrong, the collage being the one thing
         that reads `out`. Babe, 2026-10-28: "when i ran that code in dev
         tools it was fixed and then it basically reverted".
         A cold rail still fills, which is what this loop is for. */
      var mine = await newestIn(r);
      if (mine && !st(r).out) st(r).out = { filename: mine.split('/').pop(), saved: mine, url: '/' + mine };
    }

    /* 01 HAS NO RUNG BEHIND IT, so it fills from the two things that stand in
       for one: the mannequin PRESET ships with, and the newest roll the style
       slot ever made. Without this the walk starts on an empty screen, which
       is the one section that cannot borrow. */
    /* AN EMPTY CARD IS FILLED FROM THE SHEET THIS SITTING MADE, OR NOT AT ALL.
       Babe, 2026-10-26, on a brand new session opening with somebody else's
       character in it: "can we empty this out? its showing the previous
       session info".
       THE PRESET CHARACTER IS GONE, AND THE SIDECAR IS WHY. `PRESET_TRAITS`
       was a made-up bible - Babe, 2026-10-25: "can we just make some up" -
       written when the traits were the one thing this app composed and threw
       away, so a cold card had nothing to be filled from. There is something
       now: every sheet 02 makes has its five fields written down beside it,
       and `newestIn` is session-scoped, so **a new sitting is a new
       character and its card opens empty**. A preset was never session
       scoped and could only ever be the last one.
       AND IT MADE CLEAR IMPOSSIBLE. `fill` runs at boot on anything empty, so
       a cleared card came straight back on the next load wearing the preset -
       a button that cannot survive a reload is not a button.
       THE SIDECAR IS FOUND BY THE NAME IT SHARES WITH ITS PICTURE - a time, a
       model and a seed, which is already unique, so this heals if the file
       has been moved, exactly as `findKept` does on the server. */
    var two = window.HJ.slides[1];
    if (two && !Object.keys(traitsObj()).length) {
      var sheetFile = await newestIn(2);
      var kept = ((await OUTPUTS) || {}).traits || {};
      var side = sheetFile
        ? kept[sheetFile.split('/').pop().replace(/\.[a-z0-9]+$/i, '')] : null;
      var from = (side && side.traits) || {};
      var wrote = 0;
      (window.HJ.traits || []).forEach(function (t) {
        var el = two.querySelector('.tf[data-t="' + t.k + '"]');
        if (el && !el.textContent.trim() && from[t.k]) {
          el.textContent = from[t.k];
          wrote++;
        }
      });
      if (wrote) done.push('02 traits <- the sheet on disk (' + wrote + ' fields)');
    }

    var one = window.HJ.slides[0];
    if (one) {
      var ob = boxesOf(one);
      /* (*) AND THE BUST GOES IN WITHOUT SAYING WHERE IT CAME FROM, WHICH IS
         A REAL BUG LEFT STANDING ON PURPOSE. `fill` paints it and marks it
         `data-fromFile`, so it is a real input the run uploads - and nothing
         records the provenance, which is the one thing that sets
         `guide: true`. So a cold 01 sends the mannequin to nano as a
         PHOTOGRAPH OF A PERSON whose face must survive exactly, and
         `GUIDE_SYS` - keep the crop, the angle and the eye level, refuse the
         face, the bald head and the grey material - is never sent.
         THE FIX IS TWO LINES AND IT WAS REVERTED, 2026-10-27, the night
         before filming: recording `src.source = 'preset'` makes
         `restoreJourney` press the cell on the NEXT load, which is the one
         thing Babe asked against - "lets keep preset not white" - and the
         box came back wrong with it. Babe: "the bust looks different now like
         its using the wrong one". A correctness fix that changes what a slot
         shows is not a fix to make on the eve of a shoot.
         WHOEVER PICKS THIS UP: the record and the pressed cell are read by
         two different things, so they can be split - `restoreJourney` is what
         presses, and it keys on `src`. Either give the preset its own
         provenance value that nothing presses, or set `guide` from the box's
         own `data-fromFile` instead of from the journey. */
      if (ob.front[0] && !st(1).source && !emptied(1, 'source')) {
        ob.front[0].dataset.fromFile = 'bg/preset-face.png';
        showMedia(ob.front[0], '/bg/preset-face.png', false);
        done.push('01 source <- preset-face.png');
      }
      var list = await OUTPUTS;
      /* THE ROLL FOLDER IS 'random' NOW, NOT 'random-random-character'.
         This matched on '/random-', which was the old folder's own name and
         stopped matching the day the structure was simplified - so 01's
         style slot came up empty on a cold rail with a perfectly good roll
         sitting on disk. The pattern takes either, because a path healed by
         findKept can still be written in the old shape. */
      var rolls = ((list && list.files) || []).filter(function (f) {
        return inSession(f) && /\/random[-\/]/.test(f);
      });
      if (ob.front[1] && rolls[0] && !st(1).ref && !emptied(1, 'ref')) {
        ob.front[1].dataset.fromFile = rolls[0];
        showMedia(ob.front[1], '/' + rolls[0], false);
        done.push('01 ref <- ' + rolls[0].split('/').pop());
      }
    }

    /* 05's clip slot takes the only clip there is, which is whatever 04 last
       made. It is the wrong performance to transfer - the character is
       already in it - and it is the right file for walking the rail, which is
       all this command is for. */
    var five = window.HJ.slides[5];
    var vids = ((await OUTPUTS) || {}).files || [];
    var clip = vids.filter(function (f) { return isVideoName(f); })[0];
    if (five && clip && !st(6).clip && !emptied(6, 'clip')) {
      var cb = boxesOf(five).front[1];
      if (cb) {
        cb.dataset.fromFile = clip;
        showMedia(cb, '/' + clip, true);
        done.push('05 clip <- ' + clip.split('/').pop());
      }
    }

    /* the left slot of 02 and 03 is simply what the rung before it made */
    [2, 3].forEach(function (rung) {
      var slide = window.HJ.slides[rung - 1];
      var map = SLOTS[rung];
      var box = slide && boxesOf(slide).front[0];
      var made = st(rung - 1).out;
      if (!box || !made || st(rung)[map.left] || emptied(rung, map.left)) return;
      box.dataset.fromFile = made.saved;
      showMedia(box, made.url, false);
      done.push('0' + rung + ' ' + map.left + ' <- ' + made.filename);
    });

    /* AND A DRAWN BOARD COMES BACK, WHICH NOTHING DID - Babe, 2026-10-26:
       "my generated result is not showing". The board lives in a box the page
       builds rather than in a slot, so none of the three things that put the
       rail back on a reload - the journey, the slot fills, the plates - knew
       about it: 04 opened on its form with the board it had just drawn
       nowhere on the page, and the panel was the only copy. `S` has restored
       one all along, which is the shape this is. */
    var four = window.HJ.slides[3];
    var fourBox = four && four.querySelector('.slot.has-form .boardbox');
    if (fourBox && !fourBox.querySelector('img, video') && st(4).out) {
      var fslot = fourBox.closest('.slot');
      fourBox.dataset.fromFile = st(4).out.saved || '';
      showMedia(fourBox, lastingUrl(st(4).out), false);
      fslot.classList.remove('is-editing');
      fslot.classList.add('has-board');
      if (window.HJ.boardHead) window.HJ.boardHead(fslot, false);
      done.push('04 board <- ' + st(4).out.filename);
    }

    /* 04 and 05 wear two each, and the table already knows which */
    paintSheetFace();
    WEARS.forEach(function (w) {
      w.faces.forEach(function (f) {
        done.push('0' + (w.at + 1) + ' <- 0' + [].concat(f.from).join(' or 0'));
      });
    });

    /* AND A ROOM IS STILL SOMETHING SOMEBODY ACCEPTED - Babe, 2026-10-27,
       looking at 01 standing in a result they had not continued from: "lets
       keep the mannequin and the generated result should become the
       background if you continue the journey".
       THIS CALL WAS THE ONE PLACE THAT DISAGREED. `fill` runs at boot, and
       it ended by dressing every rung from the newest file in that rung's
       folder - so the room became a function of what is on disk rather than
       of what anybody said yes to, which is the exact rule `dressRung` was
       moved onto Continue journey to keep. Four runs you rejected still left
       the last of them behind you on the next load.
       IT IS QUIET AT BOOT AND LOUD ON THE KEY. SHIFT+F is the populate-it-
       so-I-can-look-at-it key and dressing is most of what it is for; a page
       load is the journey as it really is, and the rooms it really has come
       back through `restoreJourney` from the only thing that writes one. */
    if (window.HJ.dress) await window.HJ.dress({ quiet: !window.HJ._byHand });
    /* AND THE FACES ARE PAINTED AGAIN, BECAUSE A CLIP RUNG ONLY HAS A PICTURE
       OF ITSELF ONCE THE ROOMS ARE UP. 05's location wears 04's shot, and
       that shot is a frame pulled out of the clip while the plates are being
       set - so the first pass above, which runs before any of that, could
       only ever find 03. */
    paintSheetFace();
    /* last, because a collage is made of the plates and they have only just
       been put up. */
    dressCollages();
    console.log(done.length ? done.join('\n') : 'nothing in output/ to fill with');
    return done.length;
  };

  document.addEventListener('keydown', function (e) {
    var t = e.target;
    if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
    /* SHIFT+F, and the key arrives upper-case when shift is down */
    if (e.shiftKey && (e.key === 'F' || e.key === 'f')) {
      window.HJ._byHand = 1;
      Promise.resolve(window.HJ.fill()).then(function () { window.HJ._byHand = 0; });
      return;
    }
    if (e.key !== 's' && e.key !== 'S') return;
    /* SHIFT IS "ALL OF THEM". Same key, same idea, one rung or the rail. */
    if (e.shiftKey) { window.HJ.dress(); return; }
    window.HJ.stage();
  });

  /* ---------------------------------------------------------- the sitting
     A SESSION IS A SITTING AND THE SERVER OWNS WHICH ONE IS CURRENT, because
     `output/` has to agree with the rail: a new sitting writes into its own
     folder, so the rail it dresses itself from is empty and the character you
     made yesterday is not standing in it.
     NOTHING IS DELETED, EVER. `HJ.newSession()` starts one, `HJ.session(name)`
     goes back to one, and both leave every file and every saved journey where
     they are - Babe, 2026-10-26: "i want to keep that other session state as
     well tho". */
  window.HJ.sessions = async function () {
    var j = await (await fetch('/api/session')).json();
    console.log('[hero] current:', j.session);
    (j.sessions || []).forEach(function (x) {
      console.log('  ' + x.name + (x.name === j.session ? '  <- current' : '') +
                  (x.day ? '   ' + x.day : ''));
    });
    return j;
  };

  async function switchTo(body) {
    var res = await fetch('/api/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    var j = await res.json();
    if (!res.ok) throw new Error(j.error || 'could not switch session');
    /* A NEW SITTING STARTS EMPTY, AND IT SAYS SO IN WRITING. Without this it
       would open with no drawer of its own, and an empty drawer is exactly
       what makes `restoreJourney` adopt the pre-sessions journey - so the
       new character would arrive wearing the old one's slots. Stamping the
       drawer is also the only place "a new session is empty" is stated rather
       than implied. */
    if (!(body && body.session)) {
      try {
        localStorage.setItem('hj-journey-' + j.session,
          JSON.stringify({ v: 1, rungs: {}, traits: {}, sheet: null }));
      } catch (err) { /* private window: it opens empty anyway */ }
    }
    /* A RELOAD IS THE HONEST WAY ROUND. Every slot, every plate and every
       piece of state on the rail was built from the old sitting, and putting
       them all back by hand is a second implementation of boot that can
       disagree with the first. */
    setSession(j.session);
    location.reload();
    return j.session;
  }

  /* THE DRAWER FROM BEFORE THERE WERE DRAWERS, PUT WHERE IT BELONGS. Every
     journey written before today is under `hj-journey-1`, and the first
     version of this let whichever session found its own drawer missing adopt
     it - which handed a brand new sitting the character it was created to be
     rid of. Babe, 2026-10-26: "this one has images from the previous one we
     did with the grey soldier in the garage".
     A SESSION'S OWN DRAWER IS THE ONLY ONE IT READS. The legacy one is moved
     once, at boot, to **the newest session that is not the current one** -
     the sitting it was actually written during - and then it is gone. With
     only one session on disk it stays where it is rather than being claimed
     by the sitting you are starting. */
  function retireLegacy(info) {
    var raw;
    try { raw = localStorage.getItem(LEGACY_KEY); } catch (err) { return; }
    if (!raw) return;
    var names = ((info && info.sessions) || []).map(function (x) { return x.name; });
    var prev = names.filter(function (n) { return n !== info.session; }).pop();
    if (!prev) return;
    try {
      if (!localStorage.getItem('hj-journey-' + prev)) {
        localStorage.setItem('hj-journey-' + prev, raw);
      }
      localStorage.removeItem(LEGACY_KEY);
      console.log('[hero] the pre-session journey is now ' + prev + '\'s');
    } catch (err) { /* private window: nothing to move */ }
  }

  window.HJ.newSession = function () { return switchTo({}); };
  window.HJ.session = function (name) { return switchTo({ session: name }); };

  /* LAST, SO THERE IS SOMETHING TO RESTORE INTO: every slot is bound and
     every tray is wired by here, so filling them is just filling them.
     AND THE SITTING COMES FIRST, because it decides which journey is restored
     and which files the rail may dress itself from. A server that cannot
     answer leaves `SESSION` empty, which is the behaviour this had before
     sessions existed: one drawer, every file. */
  /* AND THE URL CAN SAY WHICH SITTING, so switching one does not mean opening
     a console - Babe, 2026-10-26: "do i add that to the url or how do i go
     about that". `?session=session02` goes back to one, `?session=new` starts
     one, and anything else is reported rather than guessed at.
     IT IS TAKEN OFF THE URL ONCE IT HAS BEEN ACTED ON. A parameter that stays
     is a parameter that fires again on the next reload, so a bookmarked
     `?session=new` would start a sitting every time the page opened, and a
     stale name would quietly undo the next `HJ.newSession()`. */
  async function sessionFromUrl() {
    var want;
    try { want = new URLSearchParams(location.search).get('session'); }
    catch (err) { return; }
    if (!want) return;
    try {
      var url = new URL(location.href);
      url.searchParams.delete('session');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    } catch (err) { /* the switch still happens */ }
    var res = await fetch('/api/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(want === 'new' ? {} : { session: want })
    });
    var j = await res.json();
    if (!res.ok) { console.warn('[hero] ' + (j.error || 'session switch failed')); return; }
    if (want === 'new') {
      try {
        localStorage.setItem('hj-journey-' + j.session,
          JSON.stringify({ v: 1, rungs: {}, traits: {}, sheet: null }));
      } catch (err) { /* private window: it opens empty anyway */ }
    }
    console.log('[hero] session: ' + j.session);
  }

  (async function () {
    try { await sessionFromUrl(); } catch (err) { /* reported above */ }
    try {
      var j = await (await fetch('/api/session')).json();
      if (j && j.session) { setSession(j.session); retireLegacy(j); }
    } catch (err) { /* no session endpoint: carry on as one long sitting */ }
    boot();
  })();

  function boot() {
  restoreJourney();

  /* AND THEN THE RAIL SHOWS WHAT THIS MACHINE HAS MADE. Babe, 2026-10-25:
     "basically none of the assets are loaded now" - a cold journey left four
     sections empty although `output/` was full of their work, and pressing
     SHIFT+F every reload is not a flow anyone can judge.
     IT NEVER OVERWRITES THE JOURNEY: every fill checks the slot's own state
     first, so a real run, a restored session and anything you put in a slot
     yourself all outrank it. What it dresses is the part that was empty. */
  /* AND IT DOES NOT OPEN THE WRITING FACE FOR YOU. It did for an hour -
     "it should prob start on style tab with prompt ready to go" - and the
     cost was the other two answers: a box already being typed in does not
     look like a box with PROMPT, IMPORT and RANDOM under it. Babe,
     2026-10-26: "i think we should prob revert the prompt panel to make sure
     people see the other options".
     WHAT THE HOUR BOUGHT WAS THE BUG IT EXPOSED - the slot not wearing its
     own tab's `writes` until the tab was pressed - and that stays fixed. */
  window.HJ.fill();

  /* IT USED TO BE A console.warn, WHICH IS A MESSAGE FOR WHOEVER WROTE THIS.
     A missing key stops every rung on the rail, and the one place that can
     be said is the bar - see markKey and the panel behind it. */
  health();
  }
})();
