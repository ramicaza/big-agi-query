import { callChatGenerate } from '~/modules/llms/transports/chatGenerate';
import { useModelsStore } from '~/modules/llms/store-llms';

import { useChatStore } from '~/common/state/store-chats';


const filterBigQueryMessages = (m: any) => {
  if (m.role !== 'user' && m.text.startsWith('Getting schema for `')) return false;
  try {
    const json = JSON.parse(m.text);
    if (json.fields) return false;
  } catch (e) { }
  return true;
}

/**
 * Creates the AI titles for conversations, by taking the last 5 first-lines and asking AI what's that about
 */
export function autoTitle(conversationId: string) {

  // use valid fast model
  const { fastLLMId } = useModelsStore.getState();
  if (!fastLLMId) return;

  // only operate on valid conversations, without any title
  const { conversations } = useChatStore.getState();
  const conversation = conversations.find(c => c.id === conversationId) ?? null;
  if (!conversation || conversation.autoTitle || conversation.userTitle) return;

  // first line of the last 5 messages
  const historyLines: string[] = conversation.messages.filter(filterBigQueryMessages)
  .filter(m => m.role !== 'system').slice(-5).map(m => {
    let text = m.text.split('\n')[0];
    text = text.length > 100 ? text.substring(0, 100) + '...' : text;
    text = `${m.role === 'user' ? 'You' : 'Assistant'}: ${text}`;
    return `- ${text}`;
  });

  // LLM
  void callChatGenerate(fastLLMId, [
    { role: 'system', content: `You are an AI conversation titles assistant who specializes in creating expressive yet few-words chat titles.` },
    {
      role: 'user', content:
        'Analyze the given short conversation (every line is truncated) and extract a concise chat title that ' +
        'summarizes the conversation in as little as a couple of words.\n' +
        'Only respond with the lowercase short title and nothing else.\n' +
        'Focus primarily on the initial user question when naming.\n' +
        '\n' +
        '```\n' +
        historyLines.join('\n') +
        '```\n',
    },
  ]).then(chatResponse => {

    const title = chatResponse?.content
      ?.trim()
      ?.replaceAll('"', '')
      ?.replace('Title: ', '')
      ?.replace('title: ', '');

    if (title)
      useChatStore.getState().setAutoTitle(conversationId, title);

  });

}