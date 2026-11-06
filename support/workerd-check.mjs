// Run explicitly with a locally installed Miniflare; no production bindings.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const { Miniflare } = await import(process.env.NANOLINK_MINIFLARE_MODULE
  ? pathToFileURL(resolve(process.env.NANOLINK_MINIFLARE_MODULE)).href : "miniflare");
const dir = await mkdtemp(join(tmpdir(), "nanolink-workerd-"));
const root = fileURLToPath(new URL("../", import.meta.url));
const options = {
  modules: true, scriptPath: join(root, "src/worker.mjs"),
  compatibilityDate: "2026-06-20",
  kvNamespaces: ["LINKS"], kvPersist: join(dir, "kv"),
  durableObjects: { CREATORS: { className: "LinkCreator", useSQLite: true } },
  durableObjectsPersist: join(dir, "do"),
};
let mf;
const post = body => mf.dispatchFetch("https://link.example/api/links", {
  method: "POST", body: JSON.stringify(body),
});
function card(marker, size = 64) {
  const bytes = new Uint8Array(size);
  bytes.set([137,80,78,71,13,10,26,10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13); bytes.set([73,72,68,82], 12);
  view.setUint32(16, 1200); view.setUint32(20, 630); bytes[40] = marker;
  return Buffer.from(bytes).toString("base64");
}
try {
  mf = new Miniflare(options);
  const url = "https://nanoodle.com/#state-machine-runtime-check";
  const first = await post({ url, card: card(1) });
  assert.equal(first.status, 200);
  const { slug } = await first.json();
  const parallel = await Promise.all(Array.from({ length: 40 }, (_, i) => post({ url, card: card(i + 2) })));
  assert.ok(parallel.every(res => res.status === 200));
  assert.equal(new Uint8Array(await (await mf.dispatchFetch(`https://link.example/${slug}/og.png`)).arrayBuffer())[40], 1);
  assert.equal((await mf.dispatchFetch(`https://link.example/${slug}`)).status, 200);
  assert.equal(await (await mf.dispatchFetch(`https://link.example/${slug}`, { method: "HEAD" })).text(), "");
  const kv = await mf.getKVNamespace("LINKS");
  await kv.put("AAAAAAAA", "https://nanoodle.com/#legacy");
  assert.equal((await mf.dispatchFetch("https://link.example/AAAAAAAA")).status, 200);
  const largeUrl = "https://nanoodle.com/#" + "😀".repeat(65500);
  const large = await post({ url: largeUrl, card: card(9, 200 * 1024) });
  assert.equal(large.status, 200, await large.clone().text());
  const largeSlug = (await large.json()).slug;
  await mf.dispose(); mf = new Miniflare(options);
  assert.equal((await post({ url, card: card(99) })).status, 200);
  assert.equal(new Uint8Array(await (await mf.dispatchFetch(`https://link.example/${slug}/og.png`)).arrayBuffer())[40], 1);
  assert.equal((await mf.dispatchFetch(`https://link.example/${largeSlug}/og.png`)).status, 200);
  console.log("PASS workerd: 40 concurrent retries; original image; persistent restart; legacy read; HEAD; maximum Unicode URL + 200 KiB image");
} finally {
  if (mf) await mf.dispose();
  await rm(dir, { recursive: true, force: true });
}
