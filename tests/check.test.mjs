// check.js: text in another language and valid British spellings are left as the user wrote them, by the spelling
// step and by the AI guard; everyday typos are still fixed. The AI helper is a mocked fetch: nothing leaves the
// machine, and every text is made up. Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const C = require('../check.js');
const fix = (t) => C.fixText(t, { field: 'note' }).text;

test('another language is left exactly as written', () => {
  for (const t of ['hola como estas', 'acheter du pain et du fromage', 'comprar pão e queijo amanhã', 'Termin beim Arzt vereinbaren',
    'grazie per il pranzo di domani', 'ir al médico mañana', 'café with Zoë at the crêperie', 'llamar a la abuela', 'ich bin heute müde'])
    assert.equal(fix(t), t, t);
});

test('one foreign or accented word in an English line does not stop the check', () => {
  assert.equal(fix('order a café latte and teh muffin'), 'order a café latte and the muffin');
  assert.equal(fix('don’t won’t can’t forget teh keys'), 'don’t won’t can’t forget the keys'); // phone apostrophes aren't "accents"
  assert.equal(C.foreign('pick up the pain au chocolat'), false); // "pain", "son", "come" aren't counted
});

test('valid British spellings stay; no word turns into a different one', () => {
  for (const w of ['practise', 'practised', 'practising', 'programme', 'aluminium', 'jewellery', 'enrolment', 'fulfil', 'skilful', 'instalment',
    'pyjamas', 'aeroplane', 'learnt', 'sceptical', 'ageing', 'judgement', 'artefact', 'draught', 'moustache', 'paediatrician', 'anaesthetic',
    'encyclopaedia', 'foetus', 'colour', 'organise', 'travelled', 'centre', 'catalogue', 'licence'])
    assert.equal(fix(`check the ${w} today`), `check the ${w} today`, w);
});

test('everyday typos are still fixed (the new rules are narrow)', () => {
  const cases = { 'realy need to go': 'really need to go', 'buy a smal box': 'buy a small box', 'teh plan': 'the plan', 'call the dentst': 'call the dentist',
    'specefically this': 'specifically this', 'recieve the package': 'receive the package', 'the the plan': 'the plan', 'whatcame out of it': 'what came out of it',
    'grab a apple': 'grab an apple' };
  for (const [a, b] of Object.entries(cases)) assert.equal(fix(a), b, a);
});

test('the AI guard refuses rewrites of another language, accented words and British spellings', () => {
  assert.equal(C.guard('hola como estas', 'hola come estas').ok, false);
  assert.equal(C.guard('acheter du pain et du fromage', 'acheter du pain et du from age').ok, false);
  assert.equal(C.guard('grab the crêpes', 'grab the crepes').ok, false);
  assert.equal(C.guard('practise piano', 'practice piano').ok, false);
  assert.equal(C.guard('learnt the song', 'learned the song').ok, false);
  assert.equal(C.guard('call the dentst', 'call the dentist').ok, true); // a real fix still passes
});

test('proofreadLines: a field in another language is never sent to the helper; a slow helper falls back to step 1', async () => {
  const sent = [];
  const fetchFn = async (url, init) => { const b = JSON.parse(init.body); sent.push(b.texts); return { ok: true, json: async () => ({ texts: b.texts.map((t) => t.replace('dentst', 'dentist')) }) }; };
  const res = await C.proofreadLines(['note: hola como estas amigo', 'add: call the dentst'], { url: 'https://helper.invalid', pass: 'synthetic', fetchFn, timeoutMs: 1000 });
  assert.deepEqual(sent, [['Call the dentist']]); // step 1 already fixed it; the Spanish note never left
  assert.equal(res[0].line, 'note: hola como estas amigo');
  assert.equal(res[0].ai, 'none');
  // a helper that never answers: the page's own timeout, then step 1's result
  const hang = () => new Promise(() => {});
  const late = await C.proofreadLines(['add: call teh dentist'], { url: 'https://helper.invalid', pass: 'synthetic', fetchFn: hang, timeoutMs: 50 });
  assert.equal(late[0].line, 'add: Call the dentist | said call teh dentist');
  assert.equal(late[0].ai, 'none');
});
