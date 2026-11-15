// Deterministic Demo E2E: never load the developer's .env or local LLM proxy.
import { createServer } from "vite";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root=fileURLToPath(new URL("../",import.meta.url));
const envDir=await mkdtemp(path.join(os.tmpdir(),"campusmate-demo-env-"));
process.env.VITE_SUPABASE_URL="";process.env.VITE_SUPABASE_ANON_KEY="";process.env.VITE_BACKEND_URL="";
const server=await createServer({root,configFile:path.join(root,"vite.config.ts"),envDir,server:{host:"127.0.0.1",port:5173,strictPort:true},plugins:[{name:"offline-demo-api",configureServer(vite){vite.middlewares.use((req,res,next)=>{
  if(!req.url?.startsWith("/api/")) return next();
  res.setHeader("Content-Type","application/json");
  if(req.method === "GET" && req.url === "/api/providers") return res.end(JSON.stringify({providers:[]}));
  res.statusCode=503;res.end(JSON.stringify({error:"Offline Demo E2E does not call external tools or models"}));
});}}]});
await server.listen();
process.on("SIGTERM",()=>void server.close().then(()=>process.exit(0)));
process.on("SIGINT",()=>void server.close().then(()=>process.exit(0)));
