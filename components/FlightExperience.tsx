"use client";

import { useEffect, useRef } from "react";
import type { FlightEvent, FlightHost, FlightLink } from "../lib/types";
import { config, flightStrip, contactFirstName, passDate, firstName, initials } from "../lib/flight";
import { encodePass } from "../lib/pass-token";
import { flightTrack } from "../lib/analytics";

const PASS = config.pass;

/**
 * The whole experience: boarding (S1) -> the Earth->Moon->Sun->Mars journey
 * (S2) -> the boarding pass on Mars (S3). The animation runs as a
 * self-contained vanilla routine inside one effect (scoped to this component's
 * root); React only renders the static markup and the config-driven bits.
 * The cinematic middle runs in WebGL (journey3d.ts), dynamically imported so
 * three.js never enters the initial bundle and the form never waits on it.
 *
 * mode "board": / and /<host> render the full flow and POST to /api/board.
 * mode "arrival": /p/<token> renders straight to the pass.
 */
export default function FlightExperience({
  mode,
  hostSlug,
  host,
  event,
  passengerName,
  passToken,
  issuedAt,
}: {
  mode: "board" | "arrival";
  hostSlug: string;
  host: FlightHost;
  event: FlightEvent;
  passengerName?: string;
  passToken?: string;
  // the day the pass was issued (permalink); the board flow uses today
  issuedAt?: string | null;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const passTokenRef = useRef<string | null>(passToken ?? null);
  const analytics = { host: hostSlug, event: event.tag };
  const links = host.links;
  const strip = flightStrip(event);
  const contactName = contactFirstName(host);
  const vehicle = host.vehicle;
  const custom = vehicle === "custom" ? config.customVehicle : undefined;
  const vcf = `/vcard/${hostSlug}`;

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const q = <T extends HTMLElement = HTMLElement>(id: string) => root.querySelector<T>("#" + id)!;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // preload the journey assets after first paint (the form never waits on them)
    const modelUrl = vehicle === "custom" ? custom?.model : vehicle === "horse" || vehicle === "gorilla" ? `/flight/${vehicle}.glb` : null;
    if (modelUrl) fetch(modelUrl, { priority: "low" } as RequestInit).catch(() => { /* warm-up only */ });
    ["/flight/earth.jpg", "/flight/moon.jpg", "/flight/mars-planet.jpg", "/flight/mars-surface.jpg"].forEach((s) => {
      const im = new Image();
      im.src = s;
    });

    const sky = q<HTMLCanvasElement>("sky");
    const fxc = q<HTMLCanvasElement>("fx");
    const ctx = sky.getContext("2d")!;
    const fx = fxc.getContext("2d")!;
    let W = 0, H = 0, DPR = 1;
    const streak = 0; // no hyperspace streak in the simple flow; kept for the star draw math
    type Star = { x: number; y: number; z: number; r: number };
    let stars: Star[] = [];
    type P = { x: number; y: number; vx: number; vy: number; life: number; r: number };
    const parts: P[] = [];
    let raf1 = 0, raf2 = 0, journeyRaf = 0;

    const size = () => {
      DPR = Math.min(window.devicePixelRatio || 1, 2);
      W = sky.clientWidth; H = sky.clientHeight;
      [sky, fxc].forEach((c) => { c.width = W * DPR; c.height = H * DPR; });
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0); fx.setTransform(DPR, 0, 0, DPR, 0, 0);
      const n = Math.min(230, Math.floor((W * H) / 2600));
      stars = Array.from({ length: n }, () => ({ x: Math.random() * W, y: Math.random() * H, z: Math.random(), r: Math.random() * 1.2 + 0.2 }));
    };
    size();
    const onResize = () => size();
    window.addEventListener("resize", onResize);

    const skyLoop = () => {
      ctx.clearRect(0, 0, W, H);
      const boost = 1 + streak * 13;
      for (const s of stars) {
        const sp = (0.08 + s.z * 0.4) * boost; s.y += sp; if (s.y > H) { s.y = 0; s.x = Math.random() * W; }
        ctx.globalAlpha = 0.3 + s.z * 0.6; ctx.fillStyle = s.z > 0.85 ? "#ffd0c4" : "#fff";
        if (streak > 0.02) ctx.fillRect(s.x, s.y, s.r, s.r + sp * 2.7);
        else { ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 6.283); ctx.fill(); }
      }
      ctx.globalAlpha = 1; raf1 = requestAnimationFrame(skyLoop);
    };

    const emit = (x: number, y: number, dir: number) => {
      for (let i = 0; i < 6; i++) { const a = dir + (Math.random() - 0.5) * 0.5, sp = 1.8 + Math.random() * 3;
        parts.push({ x: x + (Math.random() - 0.5) * 10, y: y + (Math.random() - 0.5) * 10, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, r: 2.5 + Math.random() * 4 }); }
    };
    const fxLoop = () => {
      fx.clearRect(0, 0, W, H);
      for (let i = parts.length - 1; i >= 0; i--) { const p = parts[i]; p.x += p.vx; p.y += p.vy; p.vx *= 0.97; p.vy *= 0.97; p.life -= 0.05; p.r *= 0.95;
        if (p.life <= 0) { parts.splice(i, 1); continue; }
        fx.globalAlpha = p.life * 0.92; fx.fillStyle = p.life > 0.62 ? "#fff" : p.life > 0.32 ? "#F0A090" : "#DC4A2F";
        fx.beginPath(); fx.arc(p.x, p.y, p.r, 0, 6.283); fx.fill(); }
      fx.globalAlpha = 1; raf2 = requestAnimationFrame(fxLoop);
    };
    // The 2D sky + exhaust only matter while they are on screen. They stop
    // under the WebGL flight and under the Mars surface, so a phone is not
    // painting two hidden canvases at 60fps next to the 3D scene.
    let bgOn = false;
    let bgStopTimer = 0;
    const startBg = () => { window.clearTimeout(bgStopTimer); if (!bgOn) { bgOn = true; skyLoop(); fxLoop(); } };
    const stopBg = () => { bgOn = false; cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); parts.length = 0; };
    startBg();

    const barsHtml = (seed: string, big: boolean) => {
      let h = 0; for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
      let out = ""; const n = big ? 46 : 60;
      for (let i = 0; i < n; i++) { h = (h * 1103515245 + 12345) >>> 0; const w = (h % 3) + 1, hg = big ? 38 : 10 + (h % 16), c = i % 7 === 0 ? "var(--coral)" : "rgba(255,255,255,.72)";
        out += `<i style="width:${w}px;height:${hg}px;background:${c};opacity:${(h % 2) ? 1 : 0.5}"></i>`; }
      return out;
    };
    // Only the boarding screen has the stub; the /p permalink renders straight
    // to the pass (this unguarded call crashed every direct pass load).
    if (mode === "board") q("stubBars").innerHTML = barsHtml(config.airline, false);

    // ---- rendered ship: key out the dark background (flood fill from edges) ----
    let shipH = 210;
    const voy = q("voyager");
    (() => {
      // The gold gorilla (and a custom pad image) is already transparent, so
      // it skips the dark-background keyout below.
      const clearSprite = vehicle === "gorilla" ? "/flight/gorilla.webp" : custom?.padImage;
      if (clearSprite) {
        const img = new Image();
        img.onload = () => { shipH = (voy.clientWidth || 74) * (img.naturalHeight / img.naturalWidth); };
        img.alt = "";
        img.src = clearSprite;
        voy.appendChild(img);
        return;
      }
      const img = new Image();
      img.onload = () => {
        const w = img.naturalWidth, h = img.naturalHeight;
        const c = document.createElement("canvas"); c.width = w; c.height = h;
        const g = c.getContext("2d")!; g.drawImage(img, 0, 0);
        let id: ImageData; try { id = g.getImageData(0, 0, w, h); } catch { return; }
        const d = id.data; const T = 84; const vis = new Uint8Array(w * h); const st: number[] = [];
        const lu = (p: number) => { const i = p << 2; return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; };
        const push = (x: number, y: number) => { if (x < 0 || y < 0 || x >= w || y >= h) return; const p = y * w + x; if (vis[p]) return; if (lu(p) < T) { vis[p] = 1; st.push(p); } };
        for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
        for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
        while (st.length) { const p = st.pop()!; d[(p << 2) + 3] = 0; const px = p % w, py = (p / w) | 0; push(px - 1, py); push(px + 1, py); push(px, py - 1); push(px, py + 1); }
        g.putImageData(id, 0, 0);
        let minX = w, minY = h, maxX = 0, maxY = 0;
        for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) { if (d[((yy * w + xx) << 2) + 3] > 16) { if (xx < minX) minX = xx; if (xx > maxX) maxX = xx; if (yy < minY) minY = yy; if (yy > maxY) maxY = yy; } }
        if (maxX < minX) return;
        const bw = maxX - minX + 1, bh = maxY - minY + 1;
        const tc = document.createElement("canvas"); tc.width = bw; tc.height = bh;
        tc.getContext("2d")!.drawImage(c, minX, minY, bw, bh, 0, 0, bw, bh);
        voy.innerHTML = `<img src="${tc.toDataURL("image/png")}" alt="">`;
        shipH = (voy.clientWidth || 74) * (bh / bw);
      };
      img.src = vehicle === "horse" ? "/flight/horse.png" : "/flight/ship.webp";
    })();

    // live pass fill
    const nameInput = mode === "board" ? q<HTMLInputElement>("nameInput") : null;
    const stubName = mode === "board" ? q("stubName") : null;
    const passName = q("passName");
    // The ticket stub looks like where your name goes, so tapping it jumps to
    // the real name field (and opens the keyboard on phones).
    const stubEl = mode === "board" ? root.querySelector<HTMLElement>(".stub") : null;
    if (stubEl && nameInput) stubEl.addEventListener("click", () => nameInput.focus());
    if (nameInput && stubName) {
      nameInput.addEventListener("input", () => {
        const v = nameInput.value.trim();
        if (v) { stubName.textContent = v.toUpperCase(); stubName.classList.remove("empty"); }
        else { stubName.textContent = "your name here"; stubName.classList.add("empty"); }
      });
    }

    // ---- sound (synth; plays on the board-tap gesture) ----
    let actx: AudioContext | null = null;
    const AC = () => { if (!actx) { try { actx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)(); } catch { /* no audio */ } } return actx; };
    const noise = (dur: number) => { const c = AC(); if (!c) return null; const b = c.createBuffer(1, c.sampleRate * dur, c.sampleRate); const dd = b.getChannelData(0); for (let i = 0; i < dd.length; i++) dd[i] = Math.random() * 2 - 1; const s = c.createBufferSource(); s.buffer = b; return s; };
    const envg = (g: GainNode, peak: number, t0: number, attack: number, dur: number) => { g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(peak, t0 + attack); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur); };
    const rumble = () => { const c = AC(); if (!c) return; const s = noise(1.8); if (!s) return; const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.setValueAtTime(360, c.currentTime); const g = c.createGain(); s.connect(lp); lp.connect(g); g.connect(c.destination); envg(g, 0.22, c.currentTime, 0.25, 1.7); s.start(); s.stop(c.currentTime + 1.8); };
    const thump = () => { const c = AC(); if (!c) return; const s = noise(0.5); if (!s) return; const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.setValueAtTime(160, c.currentTime); const g = c.createGain(); s.connect(lp); lp.connect(g); g.connect(c.destination); envg(g, 0.3, c.currentTime, 0.015, 0.45); s.start(); s.stop(c.currentTime + 0.5); };
    const whoosh = (t: number, dur: number, peak: number) => { const c = AC(); if (!c) return; const s = noise(dur); if (!s) return; const bp = c.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.setValueAtTime(300, c.currentTime + t); bp.frequency.exponentialRampToValueAtTime(3400, c.currentTime + t + dur * 0.8); const g = c.createGain(); s.connect(bp); bp.connect(g); g.connect(c.destination); envg(g, peak, c.currentTime + t, dur * 0.4, dur); s.start(c.currentTime + t); s.stop(c.currentTime + t + dur); };

    // ---- elements ----
    const boarding = mode === "board" ? q("boarding") : null;
    const arrival = q("arrival");
    const earth = q("earth"), moon = q("moon"), sun = q("sun"), marsP = q("marsP"), marsimg = q("marsimg"), marsveil = q("marsveil");
    // stage IS the root element (id="stage"), so it must be `root` itself, not
    // q("stage") - querySelector only matches descendants, so q("stage") is null
    // and every stage.classList call (shaking, webgl-on) would throw on submit.
    const sunbloom = q("sunbloom"), flash = q("flash"), stage = root, padglow = q("padglow"), earthglow = q("earthglow");
    const cap = q("cap"), landed = q("landed");
    // The thesis lines in big type. *word* is set in coral; built from text
    // nodes, never innerHTML. A new statement fades the old one out first; an
    // `add` line stacks under the one showing, so both halves stay readable.
    const thesisEl = q("thesis");
    let thesisTimer = 0;
    const thesisLine = (line: string) => {
      const el = document.createElement("span");
      el.className = "l";
      line.split(/(\*[^*]+\*)/).forEach((part) => {
        if (!part) return;
        if (part.startsWith("*") && part.endsWith("*")) {
          const em = document.createElement("em");
          em.textContent = part.slice(1, -1);
          el.appendChild(em);
        } else el.appendChild(document.createTextNode(part));
      });
      return el;
    };
    const showThesis = (line: string, add = false) => {
      window.clearTimeout(thesisTimer);
      if (add && line && thesisEl.classList.contains("on")) {
        thesisEl.appendChild(thesisLine(line));
        return;
      }
      thesisEl.classList.remove("on");
      if (!line) return;
      thesisTimer = window.setTimeout(() => {
        thesisEl.textContent = "";
        thesisEl.appendChild(thesisLine(line));
        thesisEl.classList.add("on");
      }, 180);
    };

    const sm = (a: number, b: number, p: number) => { p = p < 0 ? 0 : p > 1 ? 1 : p; p = p * p * (3 - 2 * p); return a + (b - a) * p; };
    const seg = (t: number, a: number, b: number) => (t - a) / (b - a);

    const LIFT = 1600, MOON = 3100, SUN = 4400, LAND = 6000;
    const frame = (ms: number) => {
      const ep = Math.max(0, Math.min(1, seg(ms, 0, LIFT + 800)));
      const eop = ms < 420 ? ms / 420 : ms > LIFT ? Math.max(0, 1 - seg(ms, LIFT, LIFT + 800)) : 1;
      earth.style.opacity = String(eop); earth.style.transform = `translateX(-50%) translateY(${sm(0, 320, ep)}px) scale(${sm(1.32, 0.42, ep)})`;

      const mp = seg(ms, LIFT - 100, SUN - 300);
      if (mp >= 0 && mp <= 1) { moon.style.opacity = String(Math.min(1, Math.sin(mp * Math.PI) * 1.5)); moon.style.top = sm(-28, 120, mp) + "%"; moon.style.transform = `scale(${0.55 + 0.7 * Math.sin(mp * Math.PI)})`; }
      else moon.style.opacity = "0";

      const spn = seg(ms, MOON, LAND - 700);
      if (spn >= 0 && spn <= 1) { sun.style.opacity = String(Math.min(1, Math.sin(spn * Math.PI) * 1.6)); sun.style.left = ""; sun.style.top = sm(-46, 86, spn) + "%"; sun.style.transform = `scale(${0.8 + 0.5 * Math.sin(spn * Math.PI)})`; sunbloom.style.opacity = String(Math.max(0, 1 - Math.abs(spn - 0.5) / 0.34) * 0.65); }
      else { sun.style.opacity = "0"; sunbloom.style.opacity = "0"; }

      const pp = seg(ms, SUN, LAND);
      if (pp >= 0) { marsP.style.opacity = String(Math.min(1, pp * 1.8)); marsP.style.transform = `translateX(-50%) scale(${sm(0.22, 2.4, Math.min(1, pp))})`; }
      else marsP.style.opacity = "0";

      let sx = W / 2, sy = H * 0.5, rot = 0, sc = 0.95;
      if (ms < LIFT) { const p = seg(ms, 0, LIFT); sy = H * sm(0.66, 0.48, p); sc = sm(0.9, 1, p); }
      else if (ms < MOON) { const p = seg(ms, LIFT, MOON); sy = H * 0.48; sx = W / 2 + Math.sin(p * Math.PI) * 30; rot = -Math.sin(p * Math.PI) * 12; }
      else if (ms < SUN) { const p = seg(ms, MOON, SUN); sy = H * 0.48; sx = W / 2 - Math.sin(p * Math.PI) * 24; rot = Math.sin(p * Math.PI) * 10; }
      else { const p = seg(ms, SUN, LAND); sy = H * sm(0.48, 0.6, p); sc = sm(1, 0.5, p); rot = 0; }
      // the ship sprite points up (trail below); the horse sprite faces right and
      // leaps at -55deg, so its dust trails from behind the hooves instead
      const upright = vehicle === "rocket" || (vehicle === "custom" && !custom?.padImage);
      const baseRot = upright ? 0 : -55;
      voy.style.left = sx + "px"; voy.style.top = sy + "px";
      voy.style.transform = `translate(-50%,-50%) rotate(${rot + baseRot}deg) scale(${sc})`;
      voy.style.opacity = ms > LAND - 500 ? String(Math.max(0, 1 - seg(ms, LAND - 500, LAND))) : "1";

      const exAng = ((rot + baseRot + (upright ? 90 : 180)) * Math.PI) / 180, off = shipH * 0.46 * sc;
      emit(sx + Math.cos(exAng) * off, sy + Math.sin(exAng) * off, exAng);

      let c = "";
      if (ms < LIFT) c = `DEPARTING ${event.origin}`; else if (ms < MOON) c = "PASSING THE MOON"; else if (ms < SUN) c = "ROUNDING THE SUN"; else c = `APPROACHING ${PASS.dest}`;
      cap.textContent = c; cap.style.opacity = c ? "1" : "0";
    };

    // QR on the stub encodes the pass permalink.
    const passUrl = (token: string) => `${window.location.origin}/p/${token}`;
    const qrEl = q("passQr");
    let qrFor = "";
    const setQr = (url: string) => {
      if (!url || url === qrFor) return;
      qrFor = url;
      import("qrcode-generator")
        .then((mod) => {
          const qrcode = (mod.default ?? mod) as unknown as (typeNumber: number, level: "L" | "M" | "Q" | "H") => { addData: (s: string) => void; make: () => void; createSvgTag: (o: { cellSize: number; margin: number; scalable: boolean }) => string };
          const qr = qrcode(0, "M"); qr.addData(url); qr.make();
          qrEl.innerHTML = qr.createSvgTag({ cellSize: 2, margin: 0, scalable: true });
          const svg = qrEl.querySelector("svg"); if (svg) { svg.removeAttribute("width"); svg.removeAttribute("height"); }
        })
        .catch(() => { /* stub simply stays blank */ });
    };
    const rawName = () => (mode === "arrival" ? passengerName : nameInput?.value.trim()) || "Guest";
    const arrive = () => {
      const full = rawName();
      const nm = full.toUpperCase();
      passName.textContent = nm;
      const first = firstName(full);
      q("arrFirst").textContent = first ? `${first}.` : "aboard.";
      const av = q("passAv"); if (!av.querySelector("img")) av.textContent = initials(full);
      if (passTokenRef.current) {
        setQr(passUrl(passTokenRef.current));
        if (mode === "board") { try { window.history.replaceState(null, "", `/p/${passTokenRef.current}`); } catch { /* ignore */ } }
      }
      cap.style.opacity = "0";
      showThesis("");
      [earth, moon, sun, marsP, sunbloom].forEach((el) => { el.style.transition = "opacity .7s ease"; el.style.opacity = "0"; });
      voy.style.transition = "opacity .5s ease"; voy.style.opacity = "0";
      // fade the WebGL journey (if it ran) as the DOM Mars surface fades in
      const webglEl = root.querySelector<HTMLElement>("#webgl");
      if (webglEl) { webglEl.style.transition = "opacity .8s ease"; webglEl.style.opacity = "0"; }
      const skipEl = root.querySelector<HTMLElement>("#skipJourney");
      if (skipEl) skipEl.style.display = "none";
      marsimg.classList.add("on"); marsveil.classList.add("on");
      arrival.classList.add("on"); landed.classList.add("stamp");
      bgStopTimer = window.setTimeout(stopBg, 1200); // the Mars surface now covers the 2D sky
      flightTrack("flight_pass_viewed", analytics);
    };

    if (mode === "arrival") {
      // straight to the pass (permalink / email link)
      arrive();
    } else {
      flightTrack("flight_scan_landed", analytics);
    }

    // ---- submit -> real capture -> journey -> pass ----
    let running = false;
    let webglHandle: { cancel: () => void } | null = null;
    // three r185 is WebGL2-only; anything older takes the 2D flight.
    const hasWebGL = (() => {
      try { const c = document.createElement("canvas"); return !!(window.WebGL2RenderingContext && c.getContext("webgl2")); } catch { return false; }
    })();
    const webglCanvas = root.querySelector<HTMLCanvasElement>("#webgl");
    const skipBtn = q<HTMLButtonElement>("skipJourney");
    // Each launch gets a generation number. Callbacks from a flight that was
    // skipped, replayed over or unmounted while still loading are ignored, and
    // a handle that resolves late disposes itself.
    let journeyGen = 0;
    const endJourney = () => {
      journeyGen++;
      if (webglHandle) { webglHandle.cancel(); webglHandle = null; }
      cancelAnimationFrame(journeyRaf);
      skipBtn.style.display = "none";
      arrive();
    };
    skipBtn.addEventListener("click", endJourney);

    const run2DJourney = () => {
      startBg();
      const t0 = performance.now();
      const step = (now: number) => { const ms = now - t0; frame(ms); if (ms < LAND) journeyRaf = requestAnimationFrame(step); else window.setTimeout(arrive, 60); };
      step(t0);
    };

    // The WebGL flight is built while the guest fills in the form (renderer,
    // planet photos, models, cards, compiled shaders, first frame drawn) and
    // held at t=0, so pressing board plays it at once. Downloading the files
    // early is not enough: building the scene on a phone takes seconds.
    // `me` is the handle once built; its callbacks only act while it is the
    // flight on screen (a skipped, replaced or unmounted one stays silent).
    let prepared: Promise<{ start: () => boolean; cancel: () => void; seek: (t: number) => void }> | null = null;
    const prepareFlight = () => {
      if (!hasWebGL || !webglCanvas) return null;
      if (prepared) return prepared;
      let me: { cancel: () => void } | null = null;
      const live = () => me !== null && me === webglHandle;
      // laid out (so it has a size) but transparent until it plays
      webglCanvas.style.transition = "";
      webglCanvas.style.opacity = "0";
      stage.classList.add("webgl-on");
      const p = import("./journey3d").then((mod) =>
        mod.prepareJourney3d({
          canvas: webglCanvas,
          durationMs: config.journeyMs,
          vehicle,
          customVehicle: custom,
          onReady: () => {
            if (!live()) return;
            webglCanvas.style.opacity = "1";
            [sky, fxc, earth, moon, sun, marsP, sunbloom, voy].forEach((el) => { (el as HTMLElement).style.opacity = "0"; });
            stopBg();
            skipBtn.style.display = "block";
          },
          onCaption: (txt) => { if (live()) { cap.textContent = txt; cap.style.opacity = txt ? "1" : "0"; } },
          thesis: config.thesis,
          onThesis: (line, add) => { if (live()) showThesis(line, add); },
          onCue: (cue) => {
            if (!live()) return;
            if (cue === "fling") whoosh(0, 1.5, 0.13);
            else if (cue === "retro") rumble();
            else if (cue === "touchdown") thump();
          },
          onDone: () => { if (!live()) return; arrive(); window.setTimeout(() => { if (live() && webglHandle) { webglHandle.cancel(); webglHandle = null; } }, 1300); },
        }),
      ).then((h) => { me = h; return h; });
      prepared = p;
      // a failed build is retried (or falls back to 2D) at launch
      p.catch(() => { if (prepared === p) prepared = null; });
      return p;
    };

    // Play the flight: the cinematic WebGL journey when supported, else the 2D
    // fallback. Shared by the first launch (submit) and the replay button.
    const run2DFallback = () => {
      stage.classList.remove("webgl-on");
      if (webglCanvas) webglCanvas.style.opacity = "";
      sky.style.opacity = ""; fxc.style.opacity = "";
      run2DJourney();
    };
    const playJourney = (retry = true) => {
      const gen = ++journeyGen;
      const p = prepareFlight();
      if (!p) { run2DJourney(); return; }
      prepared = null; // this one is spent; a replay builds a fresh flight
      p.then((h) => {
        if (gen !== journeyGen) { h.cancel(); return; }
        webglHandle = h;
        // dev-only QA hook: window.__flyJourney.seek(t) freezes any frame
        if (process.env.NODE_ENV !== "production") (window as unknown as { __flyJourney?: unknown }).__flyJourney = h;
        if (h.start()) return;
        // the GPU context was lost while it waited (backgrounded tab): rebuild once
        webglHandle = null;
        h.cancel();
        if (retry) playJourney(false); else run2DFallback();
      }).catch(() => {
        if (gen !== journeyGen) return;
        run2DFallback();
      });
    };

    // The launch beat (sound, flash, shake) + the flight. The flash covers the
    // swap from the 2D pad ship to the 3D scene.
    const launch = () => {
      voy.classList.remove("idle");
      voy.classList.remove("descend");
      if (boarding) boarding.style.opacity = "0";
      earthglow.style.opacity = "0";
      const cAc = AC(); if (cAc && cAc.state === "suspended") cAc.resume();
      rumble(); whoosh(1.2, 1.3, 0.12); whoosh(2.9, 1.5, 0.11);
      stage.classList.add("shaking"); flash.style.transition = "opacity .3s"; flash.style.opacity = "1";
      window.setTimeout(() => { flash.style.opacity = "0"; }, 420);
      window.setTimeout(() => { stage.classList.remove("shaking"); }, 560);
      padglow.style.transition = "opacity .6s"; padglow.style.opacity = "0";
      playJourney();
    };

    // The ship (or horse) waits above the form; on board it drops back to the
    // pad first, then takes off from there.
    const startJourney = () => {
      if (reduce) { if (boarding) boarding.style.opacity = "0"; window.setTimeout(arrive, 500); return; }
      if (mode === "board" && voy.classList.contains("idle")) {
        voy.classList.remove("idle");
        voy.classList.add("descend");
        window.setTimeout(launch, 520);
        return;
      }
      launch();
    };

    // Replay from the pass: tear down anything running, hide the pass + Mars
    // surface, then fly again. Works on both the board flow and the /p permalink.
    const replayFlight = () => {
      if (reduce) return;
      if (webglHandle) { webglHandle.cancel(); webglHandle = null; }
      cancelAnimationFrame(journeyRaf);
      arrival.classList.remove("on");
      landed.classList.remove("stamp");
      marsimg.classList.remove("on");
      marsveil.classList.remove("on");
      const wc = root.querySelector<HTMLElement>("#webgl");
      if (wc) { wc.style.transition = ""; wc.style.opacity = "1"; }
      cap.style.opacity = "0";
      launch();
    };
    const replayBtn = q<HTMLButtonElement>("replayFlight");
    replayBtn.addEventListener("click", replayFlight);

    const form = mode === "board" ? q<HTMLFormElement>("form") : null;
    const onSubmit = (e: Event) => {
      e.preventDefault();
      if (running || !form || !nameInput) return;
      const email = (q<HTMLInputElement>("emailInput")).value.trim();
      const building = (q<HTMLInputElement>("buildingInput")).value.trim();
      const company = (form.elements.namedItem("company") as HTMLInputElement)?.value ?? "";
      const errEl = q("err");
      if (!nameInput.value.trim()) { errEl.textContent = "Enter your name."; return; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errEl.textContent = "Enter a valid email."; return; }
      errEl.textContent = "";
      running = true;
      flightTrack("flight_boarding_submitted", analytics);
      // The show never waits on the network: launch immediately, capture in
      // parallel, so a slow or failed API can never leave a dead screen on
      // congested conference wifi. The pass token needs no server, so the
      // permalink and its QR are ready whatever the network does.
      passTokenRef.current = encodePass({ n: nameInput.value.trim(), h: hostSlug, e: event.tag, d: new Date().toISOString().slice(0, 10) });
      startJourney();
      fetch("/api/board", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: nameInput.value.trim(), email, building, host: hostSlug, event: event.tag, company }),
      }).catch(() => { /* lead capture is best-effort from the client; the pass still shows */ });
    };
    if (form) form.addEventListener("submit", onSubmit);
    // Fetch the flight chunk and every asset it uploads (planet photos,
    // model) while the guest fills the form, so launch never waits on the
    // network. Starts shortly after the page loads; focusing the form starts it
    // early if they are quick.
    let warmed = false;
    const warmJourney = () => {
      if (warmed || !hasWebGL || reduce) return;
      warmed = true;
      prepareFlight();
    };
    if (form) form.addEventListener("focusin", warmJourney, { once: true });
    const warmTimer = mode === "board" ? window.setTimeout(warmJourney, 900) : 0;

    // ---- vcard ----
    const onSave = () => flightTrack("flight_vcard_downloaded", analytics);
    root.querySelectorAll<HTMLAnchorElement>("a[data-vcf]").forEach((a) => a.addEventListener("click", onSave));

    // ---- share pass (canvas PNG -> native share / download) ----
    const spaced = (s: string, px: number) => s.split("").join(" ".repeat(Math.max(1, Math.round(px / 3))));
    // The shared PNG mirrors the on-screen pass (same fonts, same accent, same
    // route block) so a post looks like the thing people saw on Mars.
    const cssFont = (v: string, fb: string) => (getComputedStyle(root).getPropertyValue(v).trim() || fb);
    const drawPass = async (): Promise<Blob> => {
      const DISP = cssFont("--font-anton", "Impact"), MONO = cssFont("--font-plex-mono", "monospace");
      try { await Promise.all([document.fonts.load(`400 100px ${DISP}`), document.fonts.load(`600 30px ${MONO}`)]); } catch { /* draw with fallbacks */ }
      const Wc = 1080, Hc = 1350;
      const c = document.createElement("canvas"); c.width = Wc; c.height = Hc; const g = c.getContext("2d")!;
      const bg = g.createLinearGradient(0, 0, Wc, Hc); bg.addColorStop(0, "#12131d"); bg.addColorStop(0.6, "#0a0b12"); bg.addColorStop(1, "#160d0b");
      g.fillStyle = bg; g.fillRect(0, 0, Wc, Hc);
      // card
      const cx = 70, cy = 90, cw = Wc - 140, ch = Hc - 180, r = 40;
      const rr = (x: number, y: number, w: number, h: number, rad: number) => { g.beginPath(); g.moveTo(x + rad, y); g.arcTo(x + w, y, x + w, y + h, rad); g.arcTo(x + w, y + h, x, y + h, rad); g.arcTo(x, y + h, x, y, rad); g.arcTo(x, y, x + w, y, rad); g.closePath(); };
      rr(cx, cy, cw, ch, r); g.fillStyle = "rgba(255,255,255,0.03)"; g.fill(); g.strokeStyle = "rgba(255,255,255,.16)"; g.lineWidth = 3; g.stroke();
      const x = cx + 60; let y = cy + 90;
      g.textBaseline = "alphabetic";
      g.fillStyle = "rgba(245,243,255,.55)"; g.font = `500 24px ${MONO}`; g.fillText(spaced(`FLIGHT ${event.flight}`, 6), x, y);
      g.fillStyle = "#DC4A2F"; g.textAlign = "right"; g.fillText(spaced(`PILOT: ${host.pilot}`, 6), cx + cw - 60, y); g.textAlign = "left";
      // route
      y += 150; g.fillStyle = "#F3EFE6"; g.font = `400 150px ${DISP}`;
      g.fillText(event.origin, x, y);
      g.textAlign = "right"; g.fillText(PASS.dest, cx + cw - 60, y); g.textAlign = "left";
      const ow = g.measureText(event.origin).width, dw = g.measureText(PASS.dest).width;
      g.font = `500 22px ${MONO}`; g.fillStyle = "rgba(245,243,255,.5)";
      g.fillText(spaced(event.originCity, 4), x, y + 40); g.textAlign = "right"; g.fillText(spaced(PASS.destCity, 4), cx + cw - 60, y + 40); g.textAlign = "left";
      const tx0 = x + ow + 40, tx1 = cx + cw - 60 - dw - 40, ty = y - 52;
      g.setLineDash([10, 10]); g.strokeStyle = "rgba(243,239,230,.35)"; g.lineWidth = 3; g.beginPath(); g.moveTo(tx0, ty); g.lineTo(tx1, ty); g.stroke(); g.setLineDash([]);
      g.fillStyle = "#DC4A2F"; g.beginPath(); g.arc(tx1, ty, 9, 0, 6.283); g.fill();
      // passenger
      y += 170; g.fillStyle = "rgba(245,243,255,.55)"; g.font = `500 22px ${MONO}`; g.fillText(spaced("PASSENGER", 5), x, y);
      y += 100; const nm = (passName.textContent || "GUEST"); let fs = 104; g.font = `400 ${fs}px ${DISP}`; while (g.measureText(nm).width > cw - 120 && fs > 40) { fs -= 4; g.font = `400 ${fs}px ${DISP}`; }
      g.fillStyle = "#F3EFE6"; g.fillText(nm, x, y);
      // grid
      y += 120; const cols: [string, string][] = [["DATE", passDate(issuedAt)], ["GATE", PASS.gate], ["SEAT", PASS.seat], ["CLASS", PASS.cls]]; const colw = (cw - 120) / 4;
      cols.forEach(([lab, val], i) => { const xx = x + i * colw; g.fillStyle = "rgba(245,243,255,.5)"; g.font = `500 20px ${MONO}`; g.fillText(spaced(lab, 2), xx, y); g.fillStyle = "#fff"; g.font = `600 40px ${MONO}`; g.fillText(val, xx, y + 54); });
      // perforation + stub
      y += 150; g.setLineDash([12, 12]); g.strokeStyle = "rgba(243,239,230,.3)"; g.lineWidth = 3; g.beginPath(); g.moveTo(cx + 30, y); g.lineTo(cx + cw - 30, y); g.stroke(); g.setLineDash([]);
      g.fillStyle = "#0a0b12"; g.beginPath(); g.arc(cx, y, 26, 0, 6.283); g.fill(); g.beginPath(); g.arc(cx + cw, y, 26, 0, 6.283); g.fill();
      g.save(); rr(cx, cy, cw, ch, r); g.clip(); g.fillStyle = "#F3EFE6"; g.fillRect(cx, y + 1, cw, cy + ch - y); g.restore();
      const sy = y + 70; g.fillStyle = "#6b6660"; g.font = `500 20px ${MONO}`; g.fillText(spaced("KEEP THIS STUB", 5), x, sy);
      g.fillStyle = "#1a1917"; g.font = `400 54px ${DISP}`; g.fillText(config.airline.toUpperCase(), x, sy + 70);
      g.fillStyle = "#6b6660"; g.font = `500 22px ${MONO}`; g.fillText(config.siteLabel, x, sy + 120);
      g.fillStyle = "#B7361B"; g.font = `600 24px ${MONO}`; g.fillText(host.footer, x, sy + 158);
      // stamp
      g.save(); g.translate(cx + cw - 250, cy + 300); g.rotate(-0.19); g.strokeStyle = "#DC4A2F"; g.lineWidth = 7; rr(-110, -40, 220, 80, 14); g.stroke(); g.fillStyle = "#DC4A2F"; g.font = `400 52px ${DISP}`; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(spaced("LANDED", 3), 0, 2); g.restore();
      return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png"));
    };
    const shareBtn = q<HTMLButtonElement>("sharePass");
    const onShare = async () => {
      if (shareBtn.disabled) return; shareBtn.disabled = true; const orig = shareBtn.textContent; shareBtn.textContent = "rendering...";
      try {
        const blob = await drawPass();
        const file = new File([blob], "boarding-pass.png", { type: "image/png" });
        const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean };
        if (nav.canShare && nav.canShare({ files: [file] })) { await nav.share({ files: [file], title: `my ${config.airline} boarding pass` }); flightTrack("flight_pass_shared", { ...analytics, method: "share" }); }
        else { const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = "boarding-pass.png"; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url); flightTrack("flight_pass_shared", { ...analytics, method: "download" }); }
      } catch { /* cancelled */ } finally { shareBtn.disabled = false; shareBtn.textContent = orig; }
    };
    shareBtn.addEventListener("click", onShare);

    return () => {
      journeyGen++;
      window.clearTimeout(bgStopTimer); window.clearTimeout(thesisTimer); window.clearTimeout(warmTimer); stopBg(); cancelAnimationFrame(journeyRaf);
      if (webglHandle) { webglHandle.cancel(); webglHandle = null; }
      if (prepared) { prepared.then((h) => h.cancel()).catch(() => { /* never built */ }); prepared = null; }
      window.removeEventListener("resize", onResize);
      if (actx) { try { actx.close(); } catch { /* ignore */ } }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pilot = `PILOT: ${host.pilot}`;
  const vehicleGlyph = vehicle === "gorilla" ? (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <ellipse cx="12" cy="6.6" rx="3.6" ry="3" fill="#E9B949" />
      <circle cx="4.9" cy="12.6" r="1.8" fill="#E9B949" />
      <circle cx="19.1" cy="12.6" r="1.8" fill="#E9B949" />
      <ellipse cx="12" cy="12.8" rx="6.9" ry="6.7" fill="#E9B949" />
      <path d="M8 10.6h8" stroke="#0b0c14" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="9.7" cy="12.6" r=".95" fill="#0b0c14" />
      <circle cx="14.3" cy="12.6" r=".95" fill="#0b0c14" />
      <ellipse cx="12" cy="16.2" rx="3.7" ry="2.5" fill="#F3EFE6" />
      <circle cx="11" cy="15.6" r=".6" fill="#0b0c14" />
      <circle cx="13" cy="15.6" r=".6" fill="#0b0c14" />
    </svg>
  ) : vehicle === "horse" ? (
    <svg viewBox="0 0 24 24" fill="#DC4A2F" aria-hidden="true"><path d="M13.6 4.2c1.9 0 3.3 1 4 2.4l1.8.6-.6 1.6-1.4-.3c.1.6.1 1.2 0 1.8l1.6 2.2-1.4 1-1.1-1.4c-.9.7-2 1.1-3.2 1.1h-.4L12 17.4h-1.9l.6-4.5c-1.3-.5-2.3-1.6-2.6-3l-1.5 3.6H4.7l2.1-5.3C7.6 5.7 9.6 4.2 12 4.2h1.6zm-.4 2h-1.1c-1.4 0-2.6.9-3 2.2l-.3.9c-.1.9.3 1.8 1 2.3l.4-1.3h1.9l-.5 1.7h.9c1.2 0 2.2-.8 2.5-2l.1-.4c.3-1.5-.6-3-2-3.4z" /></svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" stroke="#DC4A2F" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3c2.2 2.3 3.2 5.4 3.2 8.6V16H8.8v-4.4C8.8 8.4 9.8 5.3 12 3z" /><path d="M8.8 12.5 6 15.5V18l2.8-1.2M15.2 12.5 18 15.5V18l-2.8-1.2M10.2 16v3M13.8 16v3M12 16v4.5" /></svg>
  );

  return (
    <div id="stage" ref={rootRef} className={vehicle === "horse" ? "glitter" : undefined}>
      <canvas id="sky" />
      <canvas id="webgl" />
      <div className="body" id="marsP" />
      <div id="sun" />
      <div className="body" id="moon" />
      <div className="body" id="earth" />
      <div id="marsimg" />
      <div id="marsveil" />
      <canvas id="fx" />
      <div id="sunbloom" />
      <div id="earthglow" />
      <div id="padglow" />
      <div id="voyager" data-v={vehicle} className={mode === "arrival" ? "" : "idle"} />
      <div id="flash" />
      <div id="cap" />
      <div id="thesis" aria-live="polite" />
      <button id="skipJourney" type="button" aria-label="skip the flight">skip</button>

      {mode === "board" && (
        <section className="scene" id="boarding">
          <div className="eyebrow">{config.airline}</div>
          <div className="strip">{strip}</div>
          <h1>
            <span className="a">{`you met ${host.shortName ?? host.name}.`}</span>
            <br />
            <span className="b">{config.copy.boardLine}</span>
          </h1>
          <div className="stub">
            <div className="top"><span>BOARDING PASS</span><span>{event.flight}</span></div>
            <div className="pax"><div className="lab">PASSENGER</div><div className="nm empty" id="stubName">your name here</div></div>
            <div className="bars" id="stubBars" />
          </div>
          <form id="form" autoComplete="off" noValidate>
            <div className="hp" aria-hidden="true">
              <label>Company<input type="text" name="company" tabIndex={-1} autoComplete="off" /></label>
            </div>
            <input className="field" id="nameInput" type="text" inputMode="text" autoComplete="name" placeholder="your name" maxLength={80} aria-label="your name" />
            <input className="field" id="emailInput" type="email" inputMode="email" autoComplete="email" placeholder="your email" maxLength={254} aria-label="your email" />
            <textarea className="field" id="buildingInput" rows={2} placeholder="what are you building? (optional)" maxLength={200} aria-label="what are you building" />
            <p className="err" id="err" />
            <button id="board" type="submit">
              {config.copy.boardButton}
              <svg viewBox="0 0 24 24" fill="none"><path d="M12 3v18M12 3l6 6M12 3L6 9" stroke="#1a0b08" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          </form>
          <div className="hatch">just want the contact card?{" "}
            <a href={vcf} download data-vcf>save {contactName}&apos;s contact</a>
          </div>
        </section>
      )}

      <section className="scene" id="arrival">
        <div className="arrhead"><div className="k">{config.airline} &middot; Landed</div><div className="t">welcome to {titleCase(PASS.dest)}, <em id="arrFirst">aboard.</em></div></div>
        <div className="passwrap">
          <div className="landed" id="landed">LANDED</div>
          <div className="pass">
            <div className="ph"><span>FLIGHT {event.flight}</span><span className="pilot">{pilot}</span></div>
            <div className="route">
              <div><div className="code">{event.origin}</div><div className="city">{event.originCity}</div></div>
              <div className="track">{vehicleGlyph}</div>
              <div className="right"><div className="code">{PASS.dest}</div><div className="city">{PASS.destCity}</div></div>
            </div>
            <div className="paxrow">
              <div className="av" id="passAv">{initials(passengerName)}</div>
              <div><div className="lab">PASSENGER</div><div className="nm" id="passName">GUEST</div></div>
            </div>
            <div className="grid">
              <div><div className="lab">DATE</div><div className="val">{passDate(issuedAt)}</div></div>
              <div><div className="lab">GATE</div><div className="val">{PASS.gate}</div></div>
              <div><div className="lab">SEAT</div><div className="val">{PASS.seat}</div></div>
              <div><div className="lab">CLASS</div><div className="val">{PASS.cls}</div></div>
            </div>
            <div className="perf" />
            <div className="stubp">
              <div>
                <div className="l1">KEEP THIS STUB</div>
                <div className="l2">{config.airline.toUpperCase()}</div>
                <div className="l3">{config.siteLabel}<br /><b>{host.footer}</b></div>
              </div>
              <div className="qr" id="passQr" aria-label="pass link" />
            </div>
          </div>
        </div>

        <div className="conn">
          <div className="h">IN-FLIGHT CONNECTIONS</div>
          <ul>
            {links.map((l) => (
              <li key={l.href}><a href={l.href} target="_blank" rel="noopener noreferrer"><span className="l"><LinkIcon link={l} />{l.label}</span><span className="g">{new URL(l.href).host.replace(/^www\./, "")} <span className="arw">&rarr;</span></span></a></li>
            ))}
          </ul>
        </div>
        {config.copy.closing && <div className="closing">{config.copy.closing}</div>}
        <div className="actions">
          <a href={vcf} download data-vcf className="btn pri">save {contactName}&apos;s contact</a>
          <button className="btn" id="sharePass" type="button">share your pass</button>
          <button className="btn ghost" id="replayFlight" type="button">{vehicle === "horse" ? "replay the ride" : "replay the flight"}</button>
          <a className="btn ghost" id="boardNext" href={hostSlug === config.defaultHost ? "/" : `/${hostSlug}`}>board the next passenger &rarr;</a>
        </div>
        {vehicle === "gorilla" && (
          // the gorilla model is CC BY 4.0, which asks for a credit
          <div className="credit">gold gorilla from a model by <a href="https://www.thingiverse.com/thing:4733596" target="_blank" rel="noopener noreferrer">Digga79</a>, CC BY 4.0</div>
        )}
        {config.credit && (
          <div className="credit">made with <a href="https://github.com/Git-Agni/flight-pass" target="_blank" rel="noopener noreferrer">flight-pass</a> by <a href="https://agniverse.co" target="_blank" rel="noopener noreferrer">Agniverse</a></div>
        )}

      </section>
    </div>
  );
}

// "MARS" -> "Mars" for the arrival headline.
function titleCase(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// The mark beside each in-flight connection: a brand glyph or an emoji.
function LinkIcon({ link }: { link: FlightLink }) {
  if (link.emoji) return <span className="ic" aria-hidden="true">{link.emoji}</span>;
  const kind = link.icon;
  if (!kind) return null;
  if (kind === "linkedin")
    return (
      <svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="4" fill="#0A66C2" /><path fill="#fff" d="M7.1 9.6h2.6V18H7.1zM8.4 5.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM11.3 9.6h2.5v1.15h.04c.35-.66 1.2-1.36 2.47-1.36 2.64 0 3.13 1.74 3.13 4V18h-2.6v-4.06c0-.97-.02-2.22-1.35-2.22-1.36 0-1.57 1.06-1.57 2.15V18h-2.6z" /></svg>
    );
  if (kind === "x")
    return (
      <svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="4" fill="#000" stroke="rgba(255,255,255,.25)" /><path fill="#fff" d="M16.6 5.5h2.1l-4.6 5.3 5.4 7.2h-4.2l-3.3-4.4-3.8 4.4H6.1l4.9-5.7-5.2-6.8h4.3l3 4z" /></svg>
    );
  if (kind === "github")
    return (
      <svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="4" fill="#24292f" /><path fill="#fff" d="M12 4.6a7.4 7.4 0 0 0-2.34 14.42c.37.07.5-.16.5-.36v-1.27c-2.06.45-2.5-.99-2.5-.99-.33-.86-.82-1.09-.82-1.09-.67-.46.05-.45.05-.45.74.05 1.13.76 1.13.76.66 1.13 1.73.8 2.15.61.07-.48.26-.8.47-.99-1.64-.19-3.37-.82-3.37-3.66 0-.81.29-1.47.76-1.99-.08-.19-.33-.94.07-1.96 0 0 .62-.2 2.03.76a7 7 0 0 1 3.7 0c1.41-.96 2.03-.76 2.03-.76.4 1.02.15 1.77.07 1.96.47.52.76 1.18.76 1.99 0 2.85-1.73 3.47-3.38 3.65.27.23.5.68.5 1.37v2.03c0 .2.13.43.51.36A7.4 7.4 0 0 0 12 4.6z" /></svg>
    );
  if (kind === "instagram")
    return (
      <svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="6" fill="#d6249f" /><rect x="6" y="6" width="12" height="12" rx="3.6" fill="none" stroke="#fff" strokeWidth="1.6" /><circle cx="12" cy="12" r="2.9" fill="none" stroke="#fff" strokeWidth="1.6" /><circle cx="15.6" cy="8.4" r=".9" fill="#fff" /></svg>
    );
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="4" fill="rgba(255,255,255,.08)" stroke="rgba(255,255,255,.25)" /><path d="M10.5 13.5l3-3M9.2 11.3 7.8 12.7a2.4 2.4 0 0 0 3.4 3.4l1.4-1.4M14.8 12.7l1.4-1.4a2.4 2.4 0 0 0-3.4-3.4l-1.4 1.4" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" /></svg>
  );
}
