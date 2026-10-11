import {describe,it,expect} from 'vitest';
import {assertDocumentSafety} from '../src/spec/safety.js';
import {assertTarget} from '../src/verify/network.js';
import {buildRunnerConfig,runOverridesFromArgs} from '../src/verify/config.js';
import {SpecStore} from '../src/spec/store.js';
import {executeDevTool} from '../src/mcp/tools.js';
import {startFakeBackend} from './helpers/fakeBackend.js';
import {fileURLToPath} from 'node:url';
const store=new SpecStore(fileURLToPath(new URL('./fixtures/petstore.yaml',import.meta.url)));
describe('outbound target policy',()=>{
 it('blocks public, private and metadata destinations by default',async()=>{
  for(const url of ['http://example.com','http://10.0.0.1','http://169.254.169.254/latest','http://[fe80::1]','http://[::ffff:169.254.169.254]','http://100.100.100.200','http://0.0.0.0']) await expect(assertTarget(url)).rejects.toThrow();
  await expect(assertTarget('http://example.com',{allowHosts:['example.com']})).rejects.toThrow(/IP literals/);
  await expect(assertTarget('http://[::ffff:169.254.169.254]',{allowHosts:['::ffff:a9fe:a9fe']})).rejects.toThrow();
  await expect(assertTarget('http://127.0.0.1:1234')).resolves.toBeUndefined();
  await expect(assertTarget('http://169.254.169.254',{allowHosts:['169.254.169.254']})).rejects.toThrow();
  await expect(assertTarget('http://192.168.1.2',{allowHosts:['192.168.1.2']})).resolves.toBeUndefined();
 });
 it('guards per-step targets and disables redirect/proxy escapes',async()=>{
  const snapshot=await store.load();const config=buildRunnerConfig(snapshot,{baseUrl:'http://127.0.0.1'});
  expect(config.requester?.followRedirects).toBe(false);
  await expect(config.resolveTransport!({protocol:'graphql',url:'http://127.0.0.1'})).rejects.toThrow(/redirect enforcement/);
  await expect(config.resolveTransport!({protocol:'http',url:'http://169.254.169.254'})).rejects.toThrow();
  expect(()=>buildRunnerConfig(snapshot,{proxy:'http://127.0.0.1'})).toThrow(/proxies/);
 });
 it('uses the configured default base URL for tools without per-call override',async()=>{
  const backend=await startFakeBackend();
  try {
   const result=await executeDevTool('send_request',{operationId:'listPets'},store,{},undefined,{defaultBaseUrl:backend.url}) as any;
   expect(result.response?.status).toBe(200);
   const ping=await executeDevTool('ping_target',{},store,{},undefined,{defaultBaseUrl:backend.url}) as any;
   expect(ping.reachable).toBe(true);
  }finally{await backend.close();}
 });
 it('wires validated runtime auth into runner without persisting it',async()=>{
  const snapshot=await store.load();
  const overrides=runOverridesFromArgs(snapshot,{baseUrl:'http://127.0.0.1',auth:{type:'bearer',token:'secret'}});
  expect(buildRunnerConfig(snapshot,overrides).auth).toEqual({type:'bearer',token:'secret'});
  expect(()=>runOverridesFromArgs(snapshot,{auth:{type:'unknown'}})).toThrow();
 });
});

it('rejects external references and embedded scripts before resolution or execution',async()=>{
 for(const ref of ['http://169.254.169.254/schema','file:///etc/passwd','./private.yaml']) expect(()=>assertDocumentSafety({schema:{$ref:ref}})).toThrow(/External/);
 expect(()=>assertDocumentSafety({schema:{$ref:'#/components/schemas/Local'}})).not.toThrow();
 const snapshot=await store.load();
 for(const document of [{'x-postman-scripts':{test:'pm.sendRequest("http://169.254.169.254")'}},{paths:{'/pets':{get:{'x-postman-scripts':{prerequest:'evil'}}}}}]) expect(()=>buildRunnerConfig({...snapshot,document},{baseUrl:'http://127.0.0.1'})).toThrow(/Postman scripts/);
});
it('does not follow live redirects during ping or request execution',async()=>{
 const {createServer}=await import('node:http');
 const {pingTarget}=await import('../src/verify/ping.js');
 const {sendOne}=await import('../src/verify/send.js');
 let escaped=0;
 const destination=createServer((_req,res)=>{escaped++;res.end('unexpected');});
 await new Promise<void>(resolve=>destination.listen(0,'127.0.0.1',resolve));
 const port=(destination.address() as {port:number}).port;
 const redirect=createServer((_req,res)=>{res.writeHead(302,{location:`http://127.0.0.1:${port}/pets`});res.end();});
 await new Promise<void>(resolve=>redirect.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${(redirect.address() as {port:number}).port}`;
 try {
  expect((await pingTarget(url,5000)).status).toBe(302);
  const result=await sendOne(await store.load(),{baseUrl:url},{operationId:'listPets'},{});
  expect(result.response?.status).toBe(302);expect(escaped).toBe(0);
 }finally{
  redirect.closeAllConnections();destination.closeAllConnections();
  await Promise.all([new Promise<void>(r=>redirect.close(()=>r())),new Promise<void>(r=>destination.close(()=>r()))]);
 }
});
