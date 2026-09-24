interface CaptureLinkPageOptions {
  token: string;
  linkName: string;
  valid: boolean;
  requireChallenge: boolean;
  siteKey?: string;
}

/**
 * Zero-install recording page served at /cap/{token}. The visitor records
 * their screen with getDisplayMedia + MediaRecorder, then the page drives
 * the standard /support/capture/* protocol directly — token, batched
 * upload-session, PUT, finalize — and shows the share URL back. Deliberately
 * dependency-free: no SDK bundle, no framework, works in any modern browser.
 * Agents skip the page entirely and drive the same protocol headlessly.
 */
export function renderCaptureLinkPage(opts: CaptureLinkPageOptions): string {
  const invalid = `<!doctype html><html><head><meta charset="utf-8"><title>Capture link</title>
<style>body{font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#0a0a0a;color:#eee}</style>
</head><body><p>This capture link is invalid, expired, or has been revoked.</p></body></html>`;

  if (!opts.valid) {
    return invalid;
  }

  const turnstileBlock = opts.requireChallenge
    ? `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" async defer></script>
<div id="cf-turnstile"></div>`
    : "";

  const escapedName = opts.linkName
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Record — ${escapedName}</title>
<style>
  *{box-sizing:border-box}body{font-family:system-ui,sans-serif;max-width:520px;margin:40px auto;padding:0 16px;background:#0a0a0a;color:#eee}
  h1{font-size:20px;font-weight:600;margin-bottom:4px}.sub{color:#888;font-size:13px;margin-bottom:24px}
  label{display:block;font-size:13px;color:#aaa;margin:12px 0 4px}
  input{width:100%;padding:8px 10px;border:1px solid #333;border-radius:6px;background:#141414;color:#eee;font-size:14px}
  button{display:block;width:100%;margin-top:20px;padding:10px;border:0;border-radius:6px;background:#e5e5e5;color:#111;font-size:14px;font-weight:600;cursor:pointer}
  button:disabled{opacity:.5;cursor:default}
  button.stop{background:#dc4a4a;color:#fff}
  #status{margin-top:16px;font-size:13px;color:#888;min-height:18px;white-space:pre-wrap}
  #done{display:none;margin-top:16px;padding:14px;border:1px solid #2a5a2a;border-radius:6px;background:#0f1f0f}
  #done a{color:#7ee787}
  .hidden{display:none}
</style></head><body>
<h1>${escapedName}</h1>
<div class="sub">Record your screen to report what you're seeing. The recording is shared with the team that sent you this link.</div>
<label for="title">What happened?</label>
<input id="title" placeholder="Checkout button does nothing" required>
<label for="email">Your email</label>
<input id="email" type="email" placeholder="you@company.com" required>
<button id="record">Start recording</button>
<button id="stop" class="stop hidden">Stop and send</button>
${turnstileBlock}
<div id="status"></div>
<div id="done"></div>
<script>
(function(){
  var token = ${JSON.stringify(opts.token)};
  var requireChallenge = ${JSON.stringify(opts.requireChallenge)};
  var siteKey = ${JSON.stringify(opts.siteKey ?? "")};
  var recordBtn = document.getElementById("record");
  var stopBtn = document.getElementById("stop");
  var statusEl = document.getElementById("status");
  var doneEl = document.getElementById("done");
  var recorder = null, chunks = [], stream = null;
  var turnstileWidget = null;

  function say(msg){ statusEl.textContent = msg; }
  function fail(msg){ say("Something went wrong: " + msg); recordBtn.disabled = false; stopBtn.classList.add("hidden"); recordBtn.classList.remove("hidden"); }

  if (requireChallenge && siteKey && window.turnstile) {
    turnstileWidget = window.turnstile.render("#cf-turnstile", { sitekey: siteKey });
  }

  recordBtn.onclick = function(){
    var title = document.getElementById("title").value.trim();
    var email = document.getElementById("email").value.trim();
    if (!title || !email) { say("A title and your email are required."); return; }
    navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }).then(function(s){
      stream = s;
      var mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : (MediaRecorder.isTypeSupported("video/webm") ? "video/webm" : "video/mp4");
      recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2500000 });
      chunks = [];
      recorder.ondataavailable = function(e){ if (e.data.size) chunks.push(e.data); };
      recorder.onstop = upload;
      stream.getVideoTracks()[0].onended = function(){ if (recorder && recorder.state !== "inactive") recorder.stop(); };
      recorder.start(1000);
      recordBtn.classList.add("hidden");
      stopBtn.classList.remove("hidden");
      say("Recording… share the tab that shows the problem.");
    }).catch(function(){ say("Screen recording was cancelled or is unavailable."); });
  };

  stopBtn.onclick = function(){
    if (recorder && recorder.state !== "inactive") { recorder.stop(); }
    if (stream) { stream.getTracks().forEach(function(t){ t.stop(); }); }
    stopBtn.disabled = true;
    say("Uploading…");
  };

  function challengeToken(){
    if (!requireChallenge) return Promise.resolve(null);
    if (!window.turnstile || !turnstileWidget) return Promise.resolve(null);
    return Promise.resolve(window.turnstile.getResponse(turnstileWidget) || null);
  }

  function upload(){
    var blob = new Blob(chunks, { type: recorder && recorder.mimeType || "video/webm" });
    var title = document.getElementById("title").value.trim();
    var email = document.getElementById("email").value.trim();
    challengeToken().then(function(ts){
      return fetch("/support/capture/token", {
        method: "POST",
        headers: Object.assign({ "x-pile-capture-link": token }, ts ? { "content-type": "application/json" } : {}),
        body: ts ? JSON.stringify({ turnstileToken: ts }) : undefined
      });
    }).then(function(r){
      if (!r.ok) throw new Error("could not start capture (" + r.status + ")");
      return r.json();
    }).then(function(t){
      return fetch("/support/capture/upload-session", {
        method: "POST",
        headers: { "x-pile-capture-token": t.token, "content-type": "application/json" },
        body: JSON.stringify({
          title: title,
          visibility: "public",
          metadata: { email: email, source: "capture-link-page" },
          artifacts: [{ attachmentType: "video", fileName: "recording.webm", contentType: blob.type }]
        })
      }).then(function(r){
        if (!r.ok) throw new Error("session failed (" + r.status + ")");
        return r.json();
      }).then(function(s){
        var up = s.uploads && s.uploads[0];
        if (!up) throw new Error("no upload target");
        return fetch(up.uploadUrl, { method: "POST", headers: { "content-type": blob.type }, body: blob }).then(function(r){
          if (!r.ok) throw new Error("upload failed (" + r.status + ")");
          return t.token;
        });
      });
    }).then(function(sessionToken){
      return fetch("/support/capture/finalize", { method: "POST", headers: { "x-pile-capture-token": sessionToken } }).then(function(r){
        if (!r.ok) throw new Error("finalize failed (" + r.status + ")");
        return r.json();
      });
    }).then(function(res){
      say("");
      doneEl.style.display = "block";
      doneEl.innerHTML = res.shareUrl
        ? 'Recording sent. <a href="' + res.shareUrl + '">Watch it here</a> — the team has been notified.'
        : "Recording sent — the team has been notified.";
      recordBtn.classList.add("hidden");
      stopBtn.classList.add("hidden");
    }).catch(function(e){ fail(e.message || "unknown error"); stopBtn.disabled = false; });
  }
})();
</script></body></html>`;
}
