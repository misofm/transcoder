const audio = document.querySelector("#audio");
const status = document.querySelector("#status");
if (globalThis.Hls?.isSupported()) {
  const hls = new Hls();
  hls.loadSource("/artifact/master.m3u8");
  hls.attachMedia(audio);
  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    status.textContent = "Ready";
  });
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (data.fatal) status.textContent = "Playback failed";
  });
} else if (audio.canPlayType("application/vnd.apple.mpegurl")) {
  audio.src = "/artifact/master.m3u8";
  status.textContent = "Ready";
} else status.textContent = "HLS playback is unavailable in this browser";
