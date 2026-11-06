// Point NANOLINK_BASELINE_WORKER at an unmodified pre-audit worker module.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const { default: worker } = await import(pathToFileURL(process.env.NANOLINK_BASELINE_WORKER).href);
const values = new Map();
let puts = 0;
const LINKS = { async get() { return null; }, async put(key, value) { puts++; values.set(key, value); } };
const png = new Uint8Array(64);
png.set([137,80,78,71,13,10,26,10]);
const view = new DataView(png.buffer);
view.setUint32(8,13); png.set([73,72,68,82],12);
view.setUint32(16,1200); view.setUint32(20,630);
const url = "https://nanoodle.com/#audit-repro";
const post = card => worker.fetch(new Request("https://link.example/api/links", {
  method:"POST", body:JSON.stringify({url,card}),
}), {LINKS});
const a = Buffer.from(png).toString("base64"); png[40] = 99;
const b = Buffer.from(png).toString("base64");
const responses = await Promise.all([post(a),post(b)]);
assert.ok(responses.every(r=>r.status===200));
assert.equal(puts,4);
console.log("REPRODUCED: two concurrent requests both succeed and write both keys (4 puts); image marker 99 replaces the first card");
assert.equal([...values.values()].find(v=>v instanceof Uint8Array)[40],99);
const slug = (await responses[0].json()).slug;
LINKS.get = async key => key === slug ? "https://nanoodle.com/#different-url" : null;
const collision = await post(a);
assert.equal(collision.status,200);
console.log("REPRODUCED: an existing different URL at the computed slug incorrectly returns 200");
LINKS.get = async () => null;
LINKS.put = async key => { if (!key.startsWith("img:")) throw Error("injected record failure"); };
await assert.rejects(()=>post(a), /injected record failure/);
console.log("REPRODUCED: failure after image write escapes fetch instead of a retriable CORS error");
const head = await worker.fetch(new Request("https://link.example/", {method:"HEAD"}),{LINKS});
assert.ok((await head.text()).length>0);
console.log("REPRODUCED: HEAD returns a response body");
