import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startHatch, pendingAsks } from './helpers.js';

test('question definitions reject malformed choices and flags before creating a dialog', async () => {
  const h = await startHatch();
  try {
    for (const body of [{choices:'Yes'}, {choices:[null]}, {choices:['']}, {choices:['Same','Same']}, {choices:Array.from({length:9},(_,i)=>String(i))}, {choices:['x'.repeat(201)]}, {freeText:'false'}]) {
      assert.equal((await h.call('POST','/api/ask',{question:'Invalid',...body})).status,400);
    }
    assert.deepEqual(await pendingAsks(h), []);
    const q=(await h.call('POST','/api/ask',{question:'Choice',choices:['Yes','No']})).data;
    assert.equal((await h.call('POST',`/api/ask/${q.id}/answer`,{answer:'Other'})).status,400);
    assert.equal((await h.call('GET',`/api/ask/${q.id}`)).data.answered,false);
    const free=(await h.call('POST','/api/ask',{question:'Text',freeText:true})).data;
    assert.equal((await h.call('POST',`/api/ask/${free.id}/answer`,{answer:'Other'})).status,200);
  } finally {await h.close();}
});

test('the first answer wins, identical retries succeed and conflicting answers cannot replace it', async () => {
  const h=await startHatch();
  try {
    const {id}=(await h.call('POST','/api/ask',{question:'Proceed?'})).data;
    const answers=['Yes','No'];const results=await Promise.all(answers.map(answer=>h.call('POST',`/api/ask/${id}/answer`,{answer})));
    assert.deepEqual(results.map(result=>result.status).sort(),[200,409]);
    const accepted=answers[results.findIndex(result=>result.status===200)];
    assert.equal((await h.call('GET',`/api/ask/${id}`)).data.answer,accepted);
    assert.equal((await h.call('POST',`/api/ask/${id}/answer`,{answer:accepted})).status,200);
    assert.equal((await h.call('POST',`/api/ask/${id}/answer`,{answer:accepted==='Yes'?'No':'Yes'})).status,409);
  } finally {await h.close();}
});

test('an answer body finishing after cancellation cannot revive the cancelled question', async () => {
  const h=await startHatch();let request;
  try {
    const {id}=(await h.call('POST','/api/ask',{question:'Cancelled'})).data;const route=`/api/ask/${id}/answer`;
    const started=new Promise(resolve=>{const listener=req=>{if(req.url===route&&req.method==='POST'){h.hatch.server.off('request',listener);resolve();}};h.hatch.server.on('request',listener);});
    const response=new Promise((resolve,reject)=>{request=http.request(h.base+route,{method:'POST',headers:{'x-token':h.hatch.token,'content-type':'application/json'}},res=>{res.resume();resolve(res.statusCode);});request.on('error',reject);request.write('{"answer":');});
    await started;assert.equal((await h.call('DELETE',`/api/ask/${id}`)).status,200);request.end('"Yes"}');
    assert.equal(await response,404);assert.equal((await h.call('GET',`/api/ask/${id}`)).status,404);
  } finally {request?.destroy();await h.close();}
});

test('question IDs do not repeat when a server restarts with the same state directory', async () => {
  const first=await startHatch();let second;
  try {
    const old=(await first.call('POST','/api/ask',{question:'Old question'})).data;
    await first.close();second=await startHatch({stateDir:first.stateDir,cwd:first.dir});
    const fresh=(await second.call('POST','/api/ask',{question:'New question'})).data;
    assert.notEqual(fresh.id,old.id);assert.equal((await second.call('GET',`/api/ask/${old.id}`)).status,404);
    assert.equal((await second.call('GET',`/api/ask/${fresh.id}`)).data.answered,false);
  } finally {if(second)await second.close();else await first.close();}
});
