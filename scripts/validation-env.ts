import { loadEnvFile } from "node:process";import{execFileSync}from"node:child_process";import{readFileSync}from"node:fs";
// Validation scripts run against dev's database; VALIDATION_TARGET=staging points them at staging's copy of
// production instead (used to rehearse the switch). Outbound texts/email/push are disabled either way.
export function localValidationEnv(){
if(process.env.VALIDATION_DATABASE_URL){
  const url=new URL(process.env.VALIDATION_DATABASE_URL);
  if(process.env.CI!=="true" || !["localhost","127.0.0.1"].includes(url.hostname) || !/test|regression/.test(url.pathname)) throw new Error("CI validation requires an isolated local test database.");
  process.env.VALIDATION_DISABLE_OUTBOUND="1";process.env.LOCAL_DEVELOPMENT="true";process.env.DATABASE_DRIVER="postgres";process.env.DATABASE_URL=url.toString();return;
}
loadEnvFile("/opt/corner-ops/.env");if(process.env.LOCAL_DEVELOPMENT!=="true"||!process.env.POSTGRES_PASSWORD)throw new Error("Local development database required.");const staging=process.env.VALIDATION_TARGET==="staging";const container=staging?"corner-ops-staging-postgres":"corner-ops-postgres";const password=staging?(readFileSync("/opt/corner-ops/staging/.env","utf8").match(/^POSTGRES_PASSWORD=(.*)$/m)?.[1]||"").trim().replace(/^["']|["']$/g,""):process.env.POSTGRES_PASSWORD;if(!password)throw new Error("No database password for the validation target.");const address=execFileSync("docker",["inspect",container,"--format","{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"],{encoding:"utf8"}).trim();process.env.VALIDATION_DISABLE_OUTBOUND="1";process.env.DATABASE_DRIVER="postgres";process.env.DATABASE_URL=`postgresql://cornerops:${encodeURIComponent(password)}@${address}:5432/cornerops`}
