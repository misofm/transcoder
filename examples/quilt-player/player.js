const DOMAIN = new TextEncoder().encode("miso.aac-transcode-quilt/1\0");
const KEY_ID_DOMAIN = new TextEncoder().encode(
  "miso.aac-transcode-quilt/key-id/1\0",
);
const INFO_PREFIX = "hls-aes-128\0";
const REQUIRED_RENDITIONS = ["aac-096", "aac-160", "aac-256"];

const concat = (...arrays) => {
  const output = new Uint8Array(
    arrays.reduce((length, value) => length + value.byteLength, 0),
  );
  let offset = 0;
  for (const value of arrays) {
    output.set(value, offset);
    offset += value.byteLength;
  }
  return output;
};

export const decodeHex = (value, bytes) => {
  if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`, "u").test(value))
    throw new TypeError(`Expected ${bytes} bytes of lowercase hexadecimal`);
  return Uint8Array.from(
    value.match(/.{2}/gu).map((pair) => Number.parseInt(pair, 16)),
  );
};

const decodeBase64Url = (value) => {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value))
    throw new TypeError("Generation nonce is not canonical base64url");
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/") + "=";
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
};

const hex = (bytes) =>
  [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");

const sha256 = async (bytes) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));

export const deriveRootKeyId = async (
  rootKey,
  recordingId,
  generationNonce,
) => {
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    rootKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        hmacKey,
        concat(KEY_ID_DOMAIN, recordingId, generationNonce),
      ),
    ),
  );
};

const deriveRenditionKey = async (
  rootKey,
  recordingId,
  generationNonce,
  renditionId,
) => {
  const salt = await sha256(concat(DOMAIN, recordingId, generationNonce));
  const key = await crypto.subtle.importKey("raw", rootKey, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: new TextEncoder().encode(`${INFO_PREFIX}${renditionId}`),
    },
    key,
    { name: "AES-CBC", length: 128 },
    false,
    ["decrypt"],
  );
};

const implicitIv = (sequence) => {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 0xffffffff)
    throw new TypeError("Segment sequence is outside the IV domain");
  const iv = new Uint8Array(16);
  new DataView(iv.buffer).setUint32(12, sequence, false);
  return iv;
};

const exactKeys = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");

const parseIndex = (bytes) => {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const index = JSON.parse(source);
  if (
    !exactKeys(index, [
      "schema",
      "network",
      "recordingId",
      "generation",
      "masterPlaylist",
      "segmentTargetMs",
      "patchCount",
      "encryption",
      "renditions",
    ]) ||
    index.schema !== "miso.aac-transcode-quilt/1" ||
    !["testnet", "mainnet"].includes(index.network) ||
    !/^0x[0-9a-f]{64}$/u.test(index.recordingId) ||
    index.masterPlaylist !== "master.m3u8" ||
    !exactKeys(index.encryption, ["scheme", "kdf", "rootKeyBytes", "keyId"]) ||
    index.encryption.scheme !== "hls-aes-128-cbc-hkdf/1" ||
    index.encryption.kdf !== "hkdf-sha256" ||
    index.encryption.rootKeyBytes !== 32 ||
    !/^[0-9a-f]{64}$/u.test(index.encryption.keyId) ||
    !Array.isArray(index.renditions) ||
    index.renditions.map(({ id }) => id).join("\0") !==
      REQUIRED_RENDITIONS.join("\0")
  )
    throw new TypeError("index.json does not match the supported contract");
  decodeBase64Url(index.generation);
  return index;
};

const fileMap = (files) => {
  const map = new Map();
  for (const file of files) {
    const identifier = file.name;
    if (map.has(identifier)) throw new TypeError(`Duplicate ${identifier}`);
    map.set(identifier, file);
  }
  return map;
};

const requiredFile = (files, identifier) => {
  const file = files.get(identifier);
  if (file === undefined) throw new TypeError(`Missing ${identifier}`);
  return file;
};

const descriptorBytes = async (files, descriptor) => {
  if (
    !exactKeys(descriptor, ["identifier", "bytes", "sha256"]) ||
    typeof descriptor.identifier !== "string" ||
    !Number.isSafeInteger(descriptor.bytes) ||
    !/^[0-9a-f]{64}$/u.test(descriptor.sha256)
  )
    throw new TypeError("Malformed file descriptor");
  const bytes = new Uint8Array(
    await requiredFile(files, descriptor.identifier).arrayBuffer(),
  );
  if (bytes.byteLength !== descriptor.bytes)
    throw new TypeError(`${descriptor.identifier} has the wrong byte length`);
  if (hex(await sha256(bytes)) !== descriptor.sha256)
    throw new TypeError(`${descriptor.identifier} failed SHA-256 verification`);
  return bytes;
};

const replaceExactLine = (lines, from, to) => {
  const positions = lines.flatMap((line, index) =>
    line === from ? [index] : [],
  );
  if (positions.length !== 1) throw new TypeError(`Expected one ${from}`);
  lines[positions[0]] = to;
};

const materializeRendition = async (files, index, rendition, rootKey, urls) => {
  const generationNonce = decodeBase64Url(index.generation);
  const recordingId = decodeHex(index.recordingId.slice(2), 32);
  const key = await deriveRenditionKey(
    rootKey,
    recordingId,
    generationNonce,
    rendition.id,
  );
  const init = await descriptorBytes(files, rendition.init);
  const initUrl = URL.createObjectURL(new Blob([init], { type: "audio/mp4" }));
  urls.push(initUrl);
  const playlistFile = requiredFile(files, rendition.playlist);
  const lines = new TextDecoder("utf-8", { fatal: true })
    .decode(await playlistFile.arrayBuffer())
    .trimEnd()
    .split(/\r?\n/u);
  const keyLine = `#EXT-X-KEY:METHOD=AES-128,URI="key.external?generation=${index.generation}&rendition=${rendition.id}"`;
  const keyPosition = lines.indexOf(keyLine);
  if (
    keyPosition < 1 ||
    lines[keyPosition - 1] !== `#EXT-X-MAP:URI="${rendition.init.identifier}"`
  )
    throw new TypeError(
      `${rendition.playlist} has an unexpected key declaration`,
    );
  lines.splice(keyPosition, 1);
  replaceExactLine(
    lines,
    `#EXT-X-MAP:URI="${rendition.init.identifier}"`,
    `#EXT-X-MAP:URI="${initUrl}"`,
  );
  for (const segment of rendition.segments) {
    if (
      !exactKeys(segment, [
        "sequence",
        "identifier",
        "durationMs",
        "plainBytes",
        "cipherBytes",
        "ciphertextSha256",
      ]) ||
      !Number.isSafeInteger(segment.sequence) ||
      !Number.isSafeInteger(segment.plainBytes) ||
      !Number.isSafeInteger(segment.cipherBytes)
    )
      throw new TypeError("Malformed segment descriptor");
    const ciphertext = new Uint8Array(
      await requiredFile(files, segment.identifier).arrayBuffer(),
    );
    if (
      ciphertext.byteLength !== segment.cipherBytes ||
      hex(await sha256(ciphertext)) !== segment.ciphertextSha256
    )
      throw new TypeError(
        `${segment.identifier} failed ciphertext verification`,
      );
    const plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-CBC", iv: implicitIv(segment.sequence) },
        key,
        ciphertext,
      ),
    );
    if (plaintext.byteLength !== segment.plainBytes)
      throw new TypeError(
        `${segment.identifier} decrypted to the wrong length`,
      );
    const segmentUrl = URL.createObjectURL(
      new Blob([plaintext], { type: "audio/mp4" }),
    );
    plaintext.fill(0);
    urls.push(segmentUrl);
    replaceExactLine(lines, segment.identifier, segmentUrl);
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
  const rootKeyInput = document.querySelector("#root-key");
  const openButton = document.querySelector("#open-button");
  const toggleKey = document.querySelector("#toggle-key");
  const consoleElement = document.querySelector(".console");
  const deck = document.querySelector("#deck");
  const audio = document.querySelector("#audio");
  const setStatus = (state, label, detail) => {
    consoleElement.className = `console ${state ? `is-${state}` : ""}`;
    document.querySelector("#status-label").textContent = label;
    document.querySelector("#status-detail").textContent = detail;
  };
  const updateReady = () => {
    openButton.disabled =
      quiltInput.files.length === 0 ||
      !/^[0-9a-f]{64}$/u.test(rootKeyInput.value);
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
    updateReady();
  });
  rootKeyInput.addEventListener("input", updateReady);
  toggleKey.addEventListener("click", () => {
    const show = rootKeyInput.type === "password";
    rootKeyInput.type = show ? "text" : "password";
    toggleKey.textContent = show ? "Hide" : "Show";
    toggleKey.setAttribute("aria-label", `${show ? "Hide" : "Show"} root key`);
  });
  document.querySelector("#close-button").addEventListener("click", () => {
    releasePlayer();
    deck.hidden = true;
    setStatus(
      "",
      "Closed",
      "Decrypted media URLs and playback state were released.",
    );
  });
  audio.addEventListener("play", () => deck.classList.add("is-playing"));
  audio.addEventListener("pause", () => deck.classList.remove("is-playing"));

  openButton.addEventListener("click", async () => {
    releasePlayer();
    deck.hidden = true;
    openButton.disabled = true;
    setStatus(
      "working",
      "Verifying locally",
      "Hashing patches and deriving rendition keys…",
    );
    let rootKey;
    const suppliedKey = rootKeyInput.value;
    rootKeyInput.value = "";
    try {
      rootKey = decodeHex(suppliedKey, 32);
      const files = fileMap(quiltInput.files);
      const indexBytes = new Uint8Array(
        await requiredFile(files, "index.json").arrayBuffer(),
      );
      const index = parseIndex(indexBytes);
      verifyInventory(files, index);
      const nonce = decodeBase64Url(index.generation);
      const recordingId = decodeHex(index.recordingId.slice(2), 32);
      if (
        (await deriveRootKeyId(rootKey, recordingId, nonce)) !==
        index.encryption.keyId
      )
        throw new TypeError("Root key does not match this Quilt generation");
      const playlistUrls = new Map();
      for (const rendition of index.renditions)
        playlistUrls.set(
          rendition.playlist,
          await materializeRendition(
            files,
            index,
            rendition,
            rootKey,
            objectUrls,
          ),
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
      document.querySelector("#network").textContent = index.network;
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
        "Verified and unlocked",
        "Ciphertext matches the index hashes and is decrypted only into temporary blob URLs.",
      );
    } catch (error) {
      releasePlayer();
      setStatus(
        "error",
        "Could not open Quilt",
        error instanceof Error ? error.message : "Unknown failure",
      );
    } finally {
      rootKey?.fill(0);
      updateReady();
    }
  });
};

if (typeof document !== "undefined") bootstrap();
