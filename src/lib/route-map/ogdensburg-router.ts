import data from "./ogdensburg.json";
import { StreetRouter, type RouteMapData } from "@/lib/delivery-street-router";

let router: StreetRouter | null = null;

/** Ogdensburg's street router, built once per process from ogdensburg.json (tools/route-map/build-route-map.py). */
export function ogdensburgRouter(): StreetRouter {
  router ??= new StreetRouter(data as unknown as RouteMapData);
  return router;
}
