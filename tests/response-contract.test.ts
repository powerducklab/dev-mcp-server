import { describe,it,expect } from 'vitest';
import { responseContractChecker } from '../src/verify/response-contract.js';
import type { TestResult } from '@powerduck/openapi-cli';
const schema = {type:'object',required:['total'],properties:{total:{type:'number'}}};
const document = {openapi:'3.1.0',paths:{'/x':{get:{responses:{'200':{content:{'application/json':{schema}}}}}}}};
function result(body: unknown) {return {method:'GET',path:'/x',status:'passed',response:{status:200,contentType:'application/json',body,text:JSON.stringify(body)},assertions:[]} as unknown as TestResult;}
describe('response contract',()=>{
 it('rejects string total and preserves its location',()=>{const r=result({total:'42'});responseContractChecker(document)(r);expect(r.status).toBe('failed');expect(r.assertions?.at(-1)?.error).toContain('/total must be number');});
 it('accepts numeric total without coercion',()=>{const r=result({total:42});responseContractChecker(document)(r);expect(r.status).toBe('passed');});
 it('rejects missing required values',()=>{const r=result({});responseContractChecker(document)(r);expect(r.status).toBe('failed');});
 it('rejects undeclared response statuses',()=>{const r=result({total:42});r.response!.status=201;responseContractChecker(document)(r);expect(r.status).toBe('failed');});
});
