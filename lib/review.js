'use strict';

const { extractClaudeText, parseStructuredJson } = require('./plan');

function parseReviewResponse(stdout) {
  const text = extractClaudeText(stdout);
  const object = parseStructuredJson(text);
  const excerpt = text.slice(0, 400);
  if (!object) {
    return { kind: 'AMBIGUOUS', detail: 'review response did not contain a JSON object', excerpt };
  }
  const verdict = String(object.verdict || object.status || '').toUpperCase();
  const notes = typeof object.notes === 'string' ? object.notes.trim() : '';
  if (verdict === 'PASS') {
    return { kind: 'PASS', notes };
  }
  if (verdict === 'FIX') {
    if (!notes) {
      return { kind: 'AMBIGUOUS', detail: 'FIX verdict requires non-empty notes describing the required changes', excerpt };
    }
    return { kind: 'FIX', notes };
  }
  if (verdict === 'QUESTION') {
    const question = typeof object.question === 'string' ? object.question.trim() : '';
    if (!question) {
      return { kind: 'AMBIGUOUS', detail: 'QUESTION verdict requires non-empty question text', excerpt };
    }
    return { kind: 'QUESTION', question, notes };
  }
  return { kind: 'AMBIGUOUS', detail: `unrecognized verdict "${object.verdict || object.status || '<none>'}"; expected PASS, FIX, or QUESTION`, excerpt };
}

module.exports = { parseReviewResponse };
