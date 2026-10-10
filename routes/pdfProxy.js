const express = require("express");

const router = express.Router();

const ALLOWED_HOSTS = ["moutamadris.ma", "www.moutamadris.ma"];
const MAX_BYTES = 30 * 1024 * 1024;

router.get("/pdf-proxy", async (req, res) => {
  let target;
  try {
    target = new URL(String(req.query.url || ""));
  } catch (e) {
    return res.status(400).send("bad url");
  }

  if (target.protocol === "https:" && ALLOWED_HOSTS.includes(target.hostname)) {
    // allowed
  } else {
    return res.status(400).send("host not allowed");
  }

  try {
    const upstream = await fetch(target.toString(), {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        Referer: "https://" + target.hostname + "/",
        Accept: "application/pdf,*/*",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });

    // a redirect must not leave the allowed hosts
    const finalHost = new URL(upstream.url).hostname;
    if (ALLOWED_HOSTS.includes(finalHost) === false) {
      return res.status(400).send("redirect not allowed");
    }

    if (upstream.ok === false) {
      return res.status(upstream.status).send("upstream " + upstream.status);
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > MAX_BYTES) {
      return res.status(413).send("file too large");
    }

    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", "inline");
    res.set("Cache-Control", "public, max-age=86400");
    return res.send(buf);
  } catch (e) {
    return res.status(502).send("proxy error");
  }
});

module.exports = router;
