import type { NextConfig } from "next";
import { assertProductionSecurity } from "./src/lib/production-security";

// Pure validation only. A build must never migrate or otherwise mutate the database.
assertProductionSecurity();
const config: NextConfig = {};
export default config;
