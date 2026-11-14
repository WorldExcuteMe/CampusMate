import { act, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { describe,it,expect,vi } from "vitest";
const h=vi.hoisted(()=>({mode:"demo",callback:undefined as undefined|((e:string,s:any)=>void),session:{user:{id:"owner-a"}}}));
vi.mock("./config",()=>({supabaseClient:{auth:{getSession:async()=>({data:{session:h.session}}),onAuthStateChange:(fn:any)=>{h.callback=fn;return {data:{subscription:{unsubscribe(){}}}};}}},setRepository:(r:any)=>{h.mode=r.mode;}}));
vi.mock("@/lib/data/demo",()=>({DemoRepository:class {mode="demo";}}));
vi.mock("@/lib/data/supabase",()=>({SupabaseRepository:class {mode:string;constructor(_db:any,id:string){this.mode=id;}}}));
import { AuthProvider,useAuth,useRepository } from "./auth";

describe("AuthProvider repository switch",()=>{
  it("children never fetch Demo under an authenticated owner; owner switch clears cached data",async()=>{
    h.mode="demo";const seen:string[]=[];
    let client!: QueryClient;
    function Probe(){const id=useAuth().session?.user.id;const repository=useRepository();client=useQueryClient();useEffect(()=>{seen.push(`${id}:${repository.mode}`);},[id,repository]);return <span>{id}</span>;}
    render(<AuthProvider><Probe/></AuthProvider>);
    await waitFor(()=>expect(seen).toContain("owner-a:owner-a"));
    expect(seen).not.toContain("owner-a:demo");
    client.setQueryData(["profile"],{name:"owner-a private"});
    await act(async()=>{h.callback!("SIGNED_IN",{user:{id:"owner-b"}});});
    await waitFor(()=>expect(seen).toContain("owner-b:owner-b"));
    expect(client.getQueryData(["profile"])).toBeUndefined();
    client.setQueryData(["profile"],{name:"owner-b private"});
    await act(async()=>{h.callback!("TOKEN_REFRESHED",{user:{id:"owner-b"}});});
    expect(client.getQueryData(["profile"])).toEqual({name:"owner-b private"});
    await act(async()=>{h.callback!("SIGNED_OUT",null);});
    await waitFor(()=>expect(seen).toContain("undefined:demo"));
    expect(client.getQueryData(["profile"])).toBeUndefined();
  });
});
