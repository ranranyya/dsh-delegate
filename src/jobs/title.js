import { redactText } from '../config/redact.js';

/** A display title is task content, never a directory name or routing instruction. */
export function taskTitle(title, prompt = '') {
  const lines = String(prompt).split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  const goal = lines.findIndex(line => /^(?:#{1,6}\s*)?(?:目标|任务目标|工作内容|任务|goal|objective|task)(?:\s*[:：]|\s*$)/iu.test(line));
  let text = typeof title === 'string' ? title.trim() : '';
  if (!text && goal >= 0) {
    text = lines[goal].replace(/^(?:#{1,6}\s*)?(?:目标|任务目标|工作内容|任务|goal|objective|task)\s*[:：]?\s*/iu, '') || lines[goal + 1] || '';
  }
  if (!text) {
    text = lines.find(line => !/^(?:you are\b|act as\b|你是|你负责|```|#{1,6}\s*(?:instructions|角色|执行规则))/iu.test(line)) || '委派任务';
  }
  text = redactText(text).replace(/^[#*\-\d.\s]+/u, '').replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  const chars = Array.from(text || '委派任务');
  return chars.length > 48 ? chars.slice(0, 47).join('') + '…' : chars.join('');
}
