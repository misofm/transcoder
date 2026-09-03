const REQUIRED_RENDITIONS = ["aac-096", "aac-160", "aac-256"];

const hex = (bytes) =>
  [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");

const sha256 = async (bytes) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));

const exactKeys = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");

export const parseIndex = (bytes) => {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const index = JSON.parse(source);
  if (
    !exactKeys(index, [
      "schema",
      "recordingId",
      "generation",
      "masterPlaylist",
      "segmentTargetMs",
      "patchCount",
      "renditions",
    ]) ||
    index.schema !== "miso.aac-transcode-quilt/1" ||
    !/^0x[0-9a-f]{64}$/u.test(index.recordingId) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(index.generation) ||
    index.masterPlaylist !== "master.m3u8" ||
    !Number.isSafeInteger(index.patchCount) ||
    !Array.isArray(index.renditions) ||
    index.renditions.length !== REQUIRED_RENDITIONS.length
  )
    throw new TypeError("index.json is not a supported AAC Quilt");
  index.renditions.forEach((rendition, position) => {
    const id = REQUIRED_RENDITIONS[position];
    if (
      !exactKeys(rendition, [
        "id",
        "codec",
        "nominalBitrate",
        "averageBandwidth",
        "peakBandwidth",
        "sampleRateHz",
        "channels",
        "playlist",
        "init",
        "segments",
      ]) ||
      rendition.id !== id ||
      rendition.codec !== "mp4a.40.2" ||
      rendition.playlist !== `${id}.m3u8` ||
      !exactKeys(rendition.init, ["identifier", "bytes", "sha256"]) ||
      rendition.init.identifier !== `${id}-init.mp4` ||
      !Array.isArray(rendition.segments) ||
      rendition.segments.length === 0
    )
      throw new TypeError("Malformed rendition descriptor");
  });
  return index;
};

const fileMap = (list) => {
  const files = new Map();
  for (const file of list) {
    const path = file.webkitRelativePath || file.name;
    const identifier = path.split("/").at(-1);
    if (!identifier || files.has(identifier))
      throw new TypeError("Quilt contains duplicate file names");
    files.set(identifier, file);
  }
  return files;
};

const requiredFile = (files, identifier) => {
  const file = files.get(identifier);
  if (file === undefined) throw new TypeError(`Missing ${identifier}`);
  return file;
};

const verifyFile = async (file, descriptor) => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (
    bytes.byteLength !== descriptor.bytes ||
    hex(await sha256(bytes)) !== descriptor.sha256
  )
    throw new TypeError(`${descriptor.identifier} failed verification`);
  return bytes;
};

const replaceExactLine = (lines, expected, replacement) => {
  const positions = lines.flatMap((line, index) =>
    line === expected ? [index] : [],
  );
  if (positions.length !== 1)
    throw new TypeError(`Expected exactly one ${expected}`);
  lines[positions[0]] = replacement;
};

const materializeRendition = async (files, rendition, urls) => {
  const init = await verifyFile(
    requiredFile(files, rendition.init.identifier),
    rendition.init,
  );
  const initUrl = URL.createObjectURL(new Blob([init], { type: "audio/mp4" }));
  urls.push(initUrl);
  const lines = new TextDecoder("utf-8", { fatal: true })
    .decode(await requiredFile(files, rendition.playlist).arrayBuffer())
    .trimEnd()
    .split(/\r?\n/u);
  replaceExactLine(
    lines,
    `#EXT-X-MAP:URI="${rendition.init.identifier}"`,
    `#EXT-X-MAP:URI="${initUrl}"`,
  );
  for (const [position, segment] of rendition.segments.entries()) {
    if (
      !exactKeys(segment, [
        "sequence",
        "identifier",
        "durationMs",
        "bytes",
        "sha256",
      ]) ||
      segment.sequence !== position ||
      segment.identifier !==
        `${rendition.id}-${String(position).padStart(5, "0")}.m4s` ||
      !Number.isSafeInteger(segment.bytes) ||
      !/^[0-9a-f]{64}$/u.test(segment.sha256)
    )
      throw new TypeError("Malformed segment descriptor");
    const media = await verifyFile(
      requiredFile(files, segment.identifier),
      segment,
    );
    const mediaUrl = URL.createObjectURL(
      new Blob([media], { type: "audio/mp4" }),
    );
    urls.push(mediaUrl);
    replaceExactLine(lines, segment.identifier, mediaUrl);
  }
  const playlistUrl = URL.createObjectURL(
    new Blob([`${lines.join("\n")}\n`], {
      type: "application/vnd.apple.mpegurl",
    }),
  );
  urls.push(playlistUrl);
  return playlistUrl;
};

const verifyInventory = (files, index) => {
  const expected = new Set(["index.json", "master.m3u8"]);
  for (const rendition of index.renditions) {
    expected.add(rendition.playlist);
    expected.add(rendition.init.identifier);
    for (const segment of rendition.segments) expected.add(segment.identifier);
  }
  if (
    expected.size !== index.patchCount ||
    files.size !== expected.size ||
    [...files.keys()].some((identifier) => !expected.has(identifier))
  )
    throw new TypeError(
      "Quilt inventory or patch count does not match index.json",
    );
};

let objectUrls = [];
let hls;

const releasePlayer = () => {
  hls?.destroy();
  hls = undefined;
  document.querySelector("#audio")?.removeAttribute("src");
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls = [];
};

const bootstrap = () => {
  const quiltInput = document.querySelector("#quilt-input");
  const openButton = document.querySelector("#open-button");
  const consoleElement = document.querySelector(".console");
  const deck = document.querySelector("#deck");
  const audio = document.querySelector("#audio");
  const setStatus = (state, label, detail) => {
    consoleElement.className = `console ${state ? `is-${state}` : ""}`;
    document.querySelector("#status-label").textContent = label;
    document.querySelector("#status-detail").textContent = detail;
  };

  quiltInput.addEventListener("change", () => {
    document
      .querySelector("#drop-zone")
      .classList.toggle("is-ready", quiltInput.files.length > 0);
    setStatus(
      "",
      "Folder selected",
      `${quiltInput.files.length} local files ready for verification.`,
    );
    openButton.disabled = quiltInput.files.length === 0;
  });
  document.querySelector("#close-button").addEventListener("click", () => {
    releasePlayer();
    deck.hidden = true;
    setStatus("", "Closed", "Media URLs and playback state were released.");
  });
  audio.addEventListener("play", () => deck.classList.add("is-playing"));
  audio.addEventListener("pause", () => deck.classList.remove("is-playing"));

  openButton.addEventListener("click", async () => {
    releasePlayer();
    deck.hidden = true;
    openButton.disabled = true;
    setStatus("working", "Verifying locally", "Hashing media patches…");
    try {
      const files = fileMap(quiltInput.files);
      const indexBytes = new Uint8Array(
        await requiredFile(files, "index.json").arrayBuffer(),
      );
      const index = parseIndex(indexBytes);
      verifyInventory(files, index);
      const playlistUrls = new Map();
      for (const rendition of index.renditions)
        playlistUrls.set(
          rendition.playlist,
          await materializeRendition(files, rendition, objectUrls),
        );
      const masterLines = new TextDecoder("utf-8", { fatal: true })
        .decode(await requiredFile(files, "master.m3u8").arrayBuffer())
        .trimEnd()
        .split(/\r?\n/u);
      for (const [identifier, url] of playlistUrls)
        replaceExactLine(masterLines, identifier, url);
      const masterUrl = URL.createObjectURL(
        new Blob([`${masterLines.join("\n")}\n`], {
          type: "application/vnd.apple.mpegurl",
        }),
      );
      objectUrls.push(masterUrl);
      if (globalThis.Hls === undefined || !globalThis.Hls.isSupported())
        throw new TypeError(
          "This browser does not provide the Media Source support required by hls.js",
        );
      hls = new globalThis.Hls({ enableWorker: true });
      hls.on(globalThis.Hls.Events.ERROR, (_event, data) => {
        if (data.fatal)
          setStatus("error", "Playback error", `${data.type}: ${data.details}`);
      });
      let selectedLevel = -1;
      let activeLevel = -1;
      const renderLevels = () => {
        document.querySelectorAll("#level-strip button").forEach((element) => {
          const level = Number(element.dataset.level);
          const selected = level === selectedLevel;
          element.classList.toggle("is-selected", selected);
          element.classList.toggle("is-active", level === activeLevel);
          element.setAttribute("aria-pressed", String(selected));
        });
      };
      hls.on(globalThis.Hls.Events.LEVEL_SWITCHED, (_event, data) => {
        activeLevel = data.level;
        renderLevels();
      });
      hls.loadSource(masterUrl);
      hls.attachMedia(audio);
      document.querySelector("#generation").textContent =
        `GENERATION ${index.generation.slice(0, 12)}…`;
      document.querySelector("#recording-id").textContent = index.recordingId;
      document.querySelector("#rendition-count").textContent = String(
        index.renditions.length,
      );
      document.querySelector("#segment-count").textContent = String(
        index.renditions[0].segments.length,
      );
      document.querySelector("#index-hash").textContent = hex(
        await sha256(indexBytes),
      );
      document.querySelector("#level-strip").replaceChildren(
        ...[
          { label: "Auto", level: -1 },
          ...index.renditions.map((rendition, level) => ({
            label: rendition.id.replace("aac-", "") + " kbps",
            level,
          })),
        ].map(({ label, level }) => {
          const item = document.createElement("button");
          item.type = "button";
          item.dataset.level = String(level);
          item.textContent = label;
          item.addEventListener("click", () => {
            selectedLevel = level;
            hls.currentLevel = level;
            renderLevels();
          });
          return item;
        }),
      );
      renderLevels();
      deck.hidden = false;
      deck.scrollIntoView({ behavior: "smooth", block: "start" });
      setStatus(
        "success",
        "Verified and ready",
        "Plaintext media matches the sizes and SHA-256 hashes in index.json.",
      );
    } catch (error) {
      releasePlayer();
      setStatus(
        "error",
        "Could not open Quilt",
        error instanceof Error ? error.message : "Unknown failure",
      );
    } finally {
      openButton.disabled = quiltInput.files.length === 0;
    }
  });
};

if (typeof document !== "undefined") bootstrap();
