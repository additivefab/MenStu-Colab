# Feishu webhook relay

This Cloudflare Worker forwards encrypted Feishu event requests to the progress
system. It cannot decrypt messages, does not persist request bodies, and forwards
only the content type and Feishu signature headers.

Deploy from this directory with:

```sh
npx wrangler deploy
```

The Feishu event callback URL is:

```text
https://<worker>.<account>.workers.dev/feishu/events
```
