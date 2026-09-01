#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { sendEpsonPrint } from "../src/lib/ordering-hardware";

async function main(){
  let output=Buffer.alloc(0);
  const server=createServer(socket=>socket.on("data",chunk=>{output=Buffer.concat([output,chunk])}));
  await new Promise<void>((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const address=server.address();if(!address||typeof address==="string")throw new Error("Cash drawer fixture did not bind.");
  await sendEpsonPrint({host:"127.0.0.1",port:address.port,cashDrawerEnabled:true},["******** TEST - DO NOT MAKE ********"],{openCashDrawer:true});
  await new Promise<void>(resolve=>setTimeout(resolve,25));
  assert.ok(output.includes(Buffer.from("TEST - DO NOT MAKE")),"Test-ticket warning was not printed.");
  assert.ok(output.includes(Buffer.from([0x1b,0x70,0x00,0x19,0xfa])),"ESC/POS cash-drawer pulse was not sent.");
  output=Buffer.alloc(0);
  await sendEpsonPrint({host:"127.0.0.1",port:address.port,cashDrawerEnabled:true},[],{openCashDrawer:true,drawerOnly:true});
  await new Promise<void>(resolve=>setTimeout(resolve,25));
  await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  assert.ok(output.includes(Buffer.from([0x1b,0x70,0x00,0x19,0xfa])),"ESC/POS cash-drawer pulse was not sent.");
  assert.equal(output.includes(Buffer.from("CORNER OPS")),false,"No Sale should not waste receipt paper.");
  console.log(JSON.stringify({testPrintWarning:true,cashDrawerPulse:true,noSaleDrawerOnly:true},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1});
