#!/usr/bin/env python3
"""Verify the built Worker keeps Nanolink's production storage contract."""

import argparse
from email import policy
from email.parser import BytesParser
import json
from pathlib import Path


def read_metadata(upload):
    boundary = upload.split(b"\r\n", 1)[0]
    if not boundary.startswith(b"--"):
        raise ValueError("Expected a Wrangler multipart dry-run upload")
    envelope = BytesParser(policy=policy.default).parsebytes(
        b'Content-Type: multipart/form-data; boundary="' + boundary[2:] + b'"\r\n\r\n' + upload
    )
    for part in envelope.iter_parts():
        if part.get_param("name", header="content-disposition") == "metadata":
            return json.loads(part.get_payload(decode=True))
    raise ValueError("Wrangler upload has no metadata part")


def links_namespace(settings):
    bindings = {binding["name"]: binding for binding in settings["bindings"]}
    if bindings.get("CREATORS", {}).get("type") != "durable_object_namespace":
        raise ValueError("CREATORS is missing. Complete the reviewed first-writer cutover before enabling automatic delivery.")
    if bindings["CREATORS"].get("class_name") != "LinkCreator":
        raise ValueError("CREATORS must use the existing LinkCreator class")
    links = bindings.get("LINKS", {})
    if links.get("type") != "kv_namespace" or not links.get("namespace_id"):
        raise ValueError("LINKS must bind the existing KV namespace")
    return links["namespace_id"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("upload", type=Path)
    parser.add_argument("--live", type=Path, help="Cloudflare Worker settings API response")
    args = parser.parse_args()
    metadata = read_metadata(args.upload.read_bytes())
    namespace = links_namespace(metadata)
    if metadata.get("observability", {}).get("enabled") is not False:
        raise ValueError("The Worker must keep observability disabled")
    if args.live and links_namespace(json.loads(args.live.read_bytes())["result"]) != namespace:
        raise ValueError("The release would change the production LINKS namespace")
    print("Verified the Nanolink storage and logging contract")


if __name__ == "__main__":
    main()
