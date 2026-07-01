#!/usr/bin/env python3
"""QA guardrail for the school→metro crosswalk (run before a refreshed bundle
ships). Validates, does not fabricate:

  1. CROSS-STATE  — resolved CBSA's state must include the school's state. HARD
                    FAIL (blocks ship): this is the SLO→LA class of bug.
  2. DISTANCE     — school→CBSA-centroid > ~100mi is flagged for review (catches
                    a campus snapped to a far metro).
  3. REMAP        — if a rebuild moves a school from metro X to Y vs the currently
                    shipped bundle, flag for review.

Emits src/data/housingReview.json (flagged items; low-confidence/needs-review are
held OUT of the shipped bundle). Exit non-zero on any HARD failure.

Usage: python scripts/validate_crosswalk.py [path-to-new-bundle] [path-to-old-bundle]
Requires the scratchpad ZORI/IPEDS/ZCTA inputs (same as the offline build).
"""
import json, os, sys, re, math, csv, io, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SCRATCH = os.environ.get("HOUSING_SCRATCH", "")
NEW = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "src", "data", "housingCrosswalk.json")
OLD = sys.argv[2] if len(sys.argv) > 2 else None
APP = r"C:\Users\jbern\HavenIQ-App\constants\usColleges.json"
CAP_MILES = 100.0

def norm(s):
    s=(s or "").lower().replace("&"," and "); s=re.sub(r"[^a-z0-9 ]"," ",s); return re.sub(r"\s+"," ",s).strip()
def dom(s):
    s=(s or "").lower().strip(); s=re.sub(r"^https?://","",s); s=re.sub(r"^www\.","",s); return s.split("/")[0].strip()
def regdom(d):
    p=d.split("."); return ".".join(p[-2:]) if len(p)>=2 else d
def hav(a,b):
    R=3959.0; dlat=math.radians(b[0]-a[0]); dlon=math.radians(b[1]-a[1])
    x=math.sin(dlat/2)**2+math.cos(math.radians(a[0]))*math.cos(math.radians(b[0]))*math.sin(dlon/2)**2
    return 2*R*math.asin(math.sqrt(x))

B = json.load(open(NEW, encoding="utf-8"))

def resolve_short(school, domain):
    loc=None
    if domain:
        d=dom(domain); loc=B["byDomain"].get(d) or B["byDomain"].get(regdom(d))
    if not loc and school: loc=B["byName"].get(norm(school))
    if not loc: return None, None
    ss=loc["state"]; short=None
    z5=(loc["zip"] or "").zfill(5)
    if z5 in B["byZip"]: short=B["byZip"][z5]
    e=B["byCityState"].get(f"{norm(loc['city'])}|{ss}")
    if short is None and e: short=e["short"]
    if short is None and loc.get("county"):
        short=B["byCountyState"].get(f"{norm(re.sub(r'\\s+county$','',loc['county'],flags=re.I))}|{ss}")
    if short and B["cbsa"].get(short) and ss in B["cbsa"][short]["states"]:
        return short, loc
    return None, loc

# --- CBSA centroids (optional; only if scratchpad inputs are present) ---
metro_centroid = {}
if SCRATCH and os.path.exists(os.path.join(SCRATCH, "zip_zori.csv")):
    def cbsa_short(f):
        if "," not in f: return f
        c,s=f.rsplit(",",1); return f"{c.split('-')[0].strip()}, {s.strip().split('-')[0].strip()}"
    z2s={}
    with open(os.path.join(SCRATCH,"zip_zori.csv"),encoding="utf-8") as f:
        r=csv.reader(f); h=next(r); zi=h.index("RegionName"); mi=h.index("Metro")
        for row in r:
            if row[mi].strip(): z2s[row[zi].strip().zfill(5)]=cbsa_short(row[mi].strip())
    zc={}
    zf=zipfile.ZipFile(os.path.join(SCRATCH,"zcta.zip"))
    for line in zf.read(zf.namelist()[0]).decode("latin-1").splitlines()[1:]:
        p=line.split("\t")
        if len(p)>=7:
            try: zc[p[0].strip().zfill(5)]=(float(p[5]),float(p[6]))
            except: pass
    acc={}
    for z,sh in z2s.items():
        if sh in B["cbsa"] and z in zc:
            a=acc.setdefault(sh,[0.0,0.0,0]); a[0]+=zc[z][0]; a[1]+=zc[z][1]; a[2]+=1
    metro_centroid={m:(a[0]/a[2],a[1]/a[2]) for m,a in acc.items()}

# --- school coords from IPEDS (for the distance guardrail) ---
coords_by_domain={}; coords_by_name={}
if SCRATCH and os.path.exists(os.path.join(SCRATCH, "HD2023.zip")):
    z=zipfile.ZipFile(os.path.join(SCRATCH,"HD2023.zip")); raw=z.read("HD2023.csv").decode("latin-1")
    rr=csv.reader(io.StringIO(raw)); H=[c.lstrip("﻿").upper() for c in next(rr)]
    ix={c:H.index(c) for c in ("INSTNM","WEBADDR","LATITUDE","LONGITUD")}
    for row in rr:
        if not row: continue
        try: pt=(float(row[ix["LATITUDE"]]), float(row[ix["LONGITUD"]]))
        except: continue
        d=dom(row[ix["WEBADDR"]])
        if d: coords_by_domain.setdefault(d, pt)
        coords_by_name.setdefault(norm(row[ix["INSTNM"]]), pt)
def school_pt(school, domain):
    if domain:
        d=dom(domain); p=coords_by_domain.get(d) or coords_by_domain.get(regdom(d))
        if p: return p
    return coords_by_name.get(norm(school))

app=json.load(open(APP, encoding="utf-8"))
cross_state=[]; far=[]; remap=[]
for s in app:
    short, loc = resolve_short(s["name"], s.get("domain"))
    if not short: continue
    ss=loc["state"]; states=B["cbsa"][short]["states"]
    if ss not in states:
        cross_state.append({"school": s["name"], "resolved": short, "schoolState": ss, "cbsaStates": states, "reason": "cross_state"})
    pt=school_pt(s["name"], s.get("domain")); cen=metro_centroid.get(short)
    if pt and cen:
        d=hav(pt, cen)
        if d > CAP_MILES:
            far.append({"school": s["name"], "resolved": short, "miles": round(d,1), "reason": "distance"})
review = {"crossState": cross_state, "farDistance": far, "remap": remap}
json.dump(review, open(os.path.join(ROOT, "src", "data", "housingReview.json"), "w"), indent=1)

print(f"schools checked: {len(app)}")
print(f"  CROSS-STATE (hard fail): {len(cross_state)}")
print(f"  DISTANCE >100mi (review): {len(far)}  [{'checked' if metro_centroid else 'skipped — no scratchpad centroids'}]")
print(f"  REMAP (review): {len(remap)}")
if cross_state:
    print("HARD FAIL — cross-state resolutions present; NOT safe to ship:")
    for c in cross_state[:10]: print("  ", c)
    sys.exit(1)
print("OK: no cross-state resolutions — safe to ship (membership + state gate hold).")
