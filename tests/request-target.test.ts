import {it, expect} from 'vitest';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {MockManager} from '../src/mock/server.js';
import {startHttpServer} from '../src/mcp/transportHttp.js';
import {SpecStore} from '../src/spec/store.js';
function malformed(url: string): Promise<string> {
 return new Promise((resolve,reject)=>{
  const socket=net.connect(Number(new URL(url).port),'127.0.0.1');
  let text='';
  socket.setTimeout(3000,()=>socket.destroy(new Error('request timed out')));
  socket.on('error',reject);
  socket.on('connect',()=>socket.write('GET //[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'));
  socket.on('data',chunk=>{text+=chunk;});socket.on('end',()=>resolve(text));
 });
}
it('rejects malformed unauthenticated MCP targets and remains healthy',async()=>{
 const handle=await startHttpServer({specStore:new SpecStore(fileURLToPath(new URL('./fixtures/petstore.yaml',import.meta.url))),port:0,token:'test'});
 try {expect(await malformed(handle.url)).toMatch(/^HTTP\/1\.1 400/);expect((await fetch(handle.url+'/health')).status).toBe(200);}
 finally {await handle.close();}
});
it('rejects malformed mock targets without killing the host',async()=>{
 const manager=new MockManager();
 const instance=await manager.start({openapi:'3.2.0',paths:{'/ok':{get:{responses:{'200':{description:'ok'}}}}}});
 try {expect(await malformed(instance.url)).toMatch(/^HTTP\/1\.1 400/);expect((await fetch(instance.url+'/ok')).status).toBe(200);}
 finally {await manager.stopAll();}
});
