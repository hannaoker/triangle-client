import io, json, sys, re
ST = sys.argv[1]
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
def jl(p):
    with io.open(p, encoding="utf-8") as f: return json.load(f)
def load(build):
    return jl("%s/schema/%s/ClientRequest.json" % (ST, build)), jl("%s/schema/%s/codex_app_server_protocol.v2.schemas.json" % (ST, build))
def methods_of(cr):
    out = {}
    for v in (cr.get("oneOf") or cr.get("anyOf") or []):
        m = v.get("properties", {}).get("method", {}).get("enum", [None])[0]
        if m: out[m] = v
    return out
res = {b: load(b) for b in ("brew-exp", "bundled-exp")}
M = {b: methods_of(res[b][0]) for b in res}
print("client methods  brew-exp:", len(M["brew-exp"]), " bundled-exp:", len(M["bundled-exp"]))
print("only in brew   :", sorted(set(M["brew-exp"]) - set(M["bundled-exp"])))
print("only in bundled:", sorted(set(M["bundled-exp"]) - set(M["brew-exp"])))
print("queue methods (bundled):", sorted(m for m in M["bundled-exp"] if m.startswith("thread/queue/")))
def render(s, defs, depth=0, seen=()):
    if not isinstance(s, dict):  # JSON Schema allows boolean subschemas
        return json.dumps(s)
    if "$ref" in s:
        n = s["$ref"].split("/")[-1]
        if n in seen or depth > 2: return "<" + n + ">"
        return render(defs.get(n, {}), defs, depth + 1, seen + (n,))
    if "enum" in s: return "enum" + json.dumps(s["enum"])
    for k in ("anyOf", "oneOf"):
        if k in s: return " | ".join(render(x, defs, depth + 1, seen) for x in s[k])
    t = s.get("type")
    if t == "object" or "properties" in s:
        req = set(s.get("required", []))
        parts = ["%s%s: %s" % (k, "" if k in req else "?", render(v, defs, depth + 1, seen)) for k, v in s.get("properties", {}).items()]
        return "{ " + "; ".join(parts) + " }"
    if t == "array": return "[" + render(s.get("items", {}), defs, depth + 1, seen) + "]"
    return t if isinstance(t, str) else json.dumps(t)
for b in ("bundled-exp",):
    defs = res[b][1].get("definitions", {})
    for name in sorted(n for n in defs if re.match(r"ThreadQueue|QueuedThread|ThreadQueued|Queued", n)):
        print("\n[%s]  %s" % (name, render(defs[name], defs)[:1100]))

print("\n================ core shapes ================")
defs = res["bundled-exp"][1].get("definitions", {})
for name in ["InitializeParams", "ThreadStartParams", "ThreadStartResponse", "ThreadResumeParams", "ThreadResumeResponse", "TurnStartParams", "TurnStartResponse", "ThreadLoadedListParams", "ThreadLoadedListResponse", "ThreadAttachmentOwnerListParams", "ThreadAttachmentOwnerListResponse", "ThreadAttachmentAddParams"]:
    if name in defs:
        s = render(defs[name], defs)
        print("\n[%s]  %s" % (name, s[:1300]))
    else:
        print("\n[%s]  (not found)" % name)
# server notification names
try:
    sn = jl("%s/schema/bundled-exp/ServerNotification.json" % ST)
    names = []
    for v in (sn.get("oneOf") or sn.get("anyOf") or []):
        m = v.get("properties", {}).get("method", {}).get("enum", [None])[0]
        if m: names.append(m)
    print("\nserver notifications (%d): %s" % (len(names), ", ".join(n for n in names if n.startswith(("thread/", "turn/", "error", "item/completed", "item/started")))))
except Exception as e:
    print("ServerNotification.json:", e)
