import { leaderboard } from "@/lib/pizza-gauntlet/server";
export const runtime="nodejs";export async function GET(){try{return Response.json({leaders:await leaderboard()})}catch{return Response.json({leaders:[]})}}
