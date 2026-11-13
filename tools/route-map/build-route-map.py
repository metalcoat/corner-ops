#!/usr/bin/env python3
"""Builds src/lib/route-map/ogdensburg.json for the delivery street router (src/lib/delivery-street-router.ts).

Inputs (paths as arguments):
  graph.json   OpenStreetMap roads around Ogdensburg from Overpass, with nodes:
               way["highway"~"^(primary|...|service)$"]["access"!~"private|no"](44.665,-75.54,44.73,-75.44);(._;>;);out body;
  stops/       the owner's stop signs from the "Ogdensburg Stop Sign Map" artifact (one JSON file per sign: lat, lng)
  streets.json the artifact's street marks: [{"name": "Jay Street", "pref": "prefer"|"avoid"}, ...]
  fixes.json   OSM stop signs the owner marked "not actually there": [osm node id, ...] (optional)

Each stop sign is attached to the nearest intersection (within 30 m) and to the street it sits on, i.e. the
approach where traffic stops. Three or more signs at one intersection make it an all-way stop.
"""
import datetime, glob, json, math, os, sys

graph_path, stops_dir, streets_path, out_path = sys.argv[1:5]
fixes = set(json.load(open(sys.argv[5]))) if len(sys.argv) > 5 else set()
graph = json.load(open(graph_path))
CLASSES = ["primary", "secondary", "tertiary", "residential", "unclassified", "service", "trunk", "living_street"]
LINK = {"primary_link": "primary", "secondary_link": "secondary", "tertiary_link": "tertiary", "trunk_link": "trunk"}

osm_nodes = {e["id"]: e for e in graph["elements"] if e["type"] == "node"}
ways = [e for e in graph["elements"] if e["type"] == "way"]
used, index = [], {}
def node_index(osm_id):
    if osm_id not in index:
        index[osm_id] = len(used); used.append(osm_id)
    return index[osm_id]

names, name_index = [], {}
out_ways, degree = [], {}
for way in ways:
    tags = way.get("tags", {})
    if tags.get("highway") == "service" and not tags.get("name"): continue
    name = tags.get("name", "")
    if name not in name_index: name_index[name] = len(names); names.append(name)
    oneway = {"yes": 1, "true": 1, "1": 1, "-1": -1}.get(tags.get("oneway", ""), 0)
    if tags.get("junction") == "roundabout": oneway = 1
    highway = LINK.get(tags["highway"], tags["highway"])
    out_ways.append([name_index[name], CLASSES.index(highway) if highway in CLASSES else 3, oneway, [node_index(n) for n in way["nodes"]]])
    for n in way["nodes"]: degree[n] = degree.get(n, 0) + 1
C = math.cos(math.radians(44.6936))
def xy(lat, lng): return ((lng + 75.482) * 111320 * C, (lat - 44.6936) * 111320)
nodes = [[round(osm_nodes[n]["lat"], 6), round(osm_nodes[n]["lon"], 6)] for n in used]
junctions = {index[n] for n, d in degree.items() if d >= 2 and n in index}
# Also nodes shared inside one way's list with another way.
shared = {}
for w in out_ways:
    for n in set(w[3]): shared[n] = shared.get(n, 0) + 1
junctions |= {n for n, c in shared.items() if c >= 2}

signals = [index[n] for n, e in osm_nodes.items() if n in index and (e.get("tags", {}).get("highway") == "traffic_signals")]

# Neighbours of each junction along roads: (neighbour node, street name).
neighbours = {}
for name_i, _, _, path in out_ways:
    for a, b in zip(path, path[1:]):
        neighbours.setdefault(a, []).append((b, name_i)); neighbours.setdefault(b, []).append((a, name_i))

signs = []
for path in glob.glob(os.path.join(stops_dir, "*.json")):
    row = json.load(open(path)); row = row.get("data", row); signs.append((row["lat"], row["lng"]))
osm_stop_nodes = [e for n, e in osm_nodes.items() if e.get("tags", {}).get("highway") == "stop" and n not in fixes and n in index]

approaches = {}  # junction -> set of approach neighbour nodes (traffic coming from that neighbour stops)
unplaced = 0
for lat, lng in signs:
    p = xy(lat, lng)
    best = min(junctions, key=lambda j: math.dist(p, xy(*nodes[j])))
    if math.dist(p, xy(*nodes[best])) > 30: unplaced += 1; continue
    # The approach is the road leaving the junction whose direction best matches where the sign stands.
    jx, jy = xy(*nodes[best]); angle = math.atan2(p[1] - jy, p[0] - jx)
    def off(nb):
        nx, ny = xy(*nodes[nb[0]]); a = math.atan2(ny - jy, nx - jx); d = abs(a - angle) % (2 * math.pi); return min(d, 2 * math.pi - d)
    nb = min(neighbours.get(best, []), key=off, default=None)
    if nb: approaches.setdefault(best, set()).add(nb[0])
for e in osm_stop_nodes:  # OSM signs sit on the approach road itself, next to the junction
    i = index[e["id"]]
    if i in junctions: approaches.setdefault(i, set()).add(-1); continue
    for nb, _ in neighbours.get(i, []):
        if nb in junctions: approaches.setdefault(nb, set()).add(i); break

stops = []
for junction, froms in approaches.items():
    if -1 in froms or len(froms) >= 3: stops.append([junction, -1])  # all-way
    else: stops.extend([junction, f] for f in sorted(froms))

prefs = {s["name"]: s["pref"] for s in json.load(open(streets_path)) if s.get("pref") in ("prefer", "avoid")}
json.dump({"source": "OpenStreetMap contributors (ODbL) + Corner Deli stop sign map", "builtAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "names": names, "classes": CLASSES, "nodes": nodes, "ways": out_ways, "signals": sorted(set(signals)), "stops": stops, "prefs": prefs},
          open(out_path, "w"), separators=(",", ":"))
allway = sum(1 for s in stops if s[1] == -1)
print(f"{len(nodes)} nodes, {len(out_ways)} ways, {len(signs)} owner signs ({unplaced} not near an intersection), "
      f"{len(osm_stop_nodes)} OSM signs, {len(stops)} stop approaches ({allway} all-way), {len(signals)} signals, prefs {prefs}")
