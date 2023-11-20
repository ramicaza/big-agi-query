import { DLLMId } from '~/modules/llms/store-llms';

import { SystemPurposeId } from '../../../data';

import { createDEphemeral, DMessage, useChatStore } from '~/common/state/store-chats';

import { createAssistantTypingMessage, createTypingFunction, updatePurposeInHistory } from './editors';

import { callChatGenerate, callChatGenerateWithFunctions, VChatMessageIn, VChatFunctionIn } from '~/modules/llms/transports/chatGenerate';

import { autoTitle } from '~/modules/aifn/autotitle/autoTitle';

import type { OpenAIWire } from '~/modules/llms/transports/server/openai/openai.wiretypes';

const func: VChatFunctionIn = {
    name: 'getTableSchema',
    description: 'Gets the table schema for a given table',
    parameters: {
        type: 'object',
        properties: {
            'projectId': {
                type: 'string',
                description: 'The project (e.g. symbiosys-prod or symbiosys-eu). If not specified, the default project is used.',
            },
            'datasetId': {
                type: 'string',
                description: 'The dataset (e.g. symbiosys)',
            },
            'tableId': {
                type: 'string',
                description: 'The table',
            }
        },
        required: ['datasetId', 'tableId'],
    },
}


interface FuncArguments {
    projectId: string | undefined,
    datasetId: string,
    tableId: string
}

/**
 * Synchronous ReAct chat function - TODO: event loop, auto-ui, cleanups, etc.
 */
export async function runBigQueryUpdatingState(
    conversationId: string,
    question: string,
    assistantLlmId: DLLMId,
    getTableSchema: (projectId: string | undefined, datasetId: string, tableId: string) => Promise<any>,
    history: DMessage[] = [],
    systemPurpose: SystemPurposeId,
) {
    // update the system message from the active Purpose, if not manually edited
    history = updatePurposeInHistory(conversationId, history, systemPurpose);

    const { startTyping, editMessage, deleteMessage } = useChatStore.getState();

    const { autoSpeak, autoSuggestDiagrams, autoSuggestQuestions, autoTitleChat } = getChatAutoAI();

    const messages = history.map(({ role, text, function_call, name }) => ({ role, content: text, function_call, name })) as VChatMessageIn[];

    const controller = new AbortController();

    for (let i = 0; i < 5; i++) {
        startTyping(conversationId, controller);

        const assistantMessageId = createAssistantTypingMessage(conversationId, assistantLlmId, undefined, '...');
        let wroteText = false;
        console.log('model INPUT:', JSON.parse(JSON.stringify(messages)));
        const result = await streamAssistantMessage(assistantLlmId, messages, 'off',
            (updatedMessage) => {
                editMessage(conversationId, assistantMessageId, updatedMessage, false);
                if (updatedMessage?.text) wroteText = true;
            },
            controller.signal,
            [func]
        );
        // clear to send, again
        startTyping(conversationId, null);
        if (result?.function_call && result?.function_call.name === 'getTableSchema') {
            !wroteText && deleteMessage(conversationId, assistantMessageId); // delete the loading sign message
            console.log('model function result:', JSON.parse(JSON.stringify(result)));
            const fargs = JSON.parse(result.function_call.arguments) as FuncArguments;
            const { projectId, datasetId, tableId } = fargs;
            const prettyTable = `${projectId ? projectId + '.' : ''}${datasetId}.${tableId}`;
            console.log(`Requested SCHEMA for ${prettyTable}`);

            messages.push({ role: 'assistant', content: '', function_call: { name: result.function_call.name, arguments: fargs } });
            const gettingSchemaMsgId = createTypingFunction(
                conversationId, assistantLlmId, undefined,
                'assistant', `Getting schema for \`${prettyTable}\``,
                { name: result.function_call.name, arguments: fargs });

            let res;
            try {
                res = await getTableSchema(projectId, datasetId, tableId);
                console.log('func call RESULT', res);
            } catch (e) {
                console.log('getTableSchema error:', e);
                res = JSON.stringify(e);
            }
            // TODO: ramicaza check if json is the move here
            editMessage(conversationId, gettingSchemaMsgId, { typing: false }, false);

            messages.push({ role: 'function', content: JSON.stringify(res), name: result.function_call.name });
            const id = createTypingFunction(
                conversationId, assistantLlmId, undefined, 'function',
                JSON.stringify(res), undefined,
                result.function_call.name
            );
            editMessage(conversationId, id, { typing: false }, false);
        } else if (result?.function_call && result.function_call.name !== 'getTableSchema') {
            console.log(`ERROR: Unknown function name: ${result.function_call.name}`);
            !wroteText && deleteMessage(conversationId, assistantMessageId); // delete the loading sign message
            const error = JSON.stringify({ 'error': `Unknown function name: ${result.function_call.name}` });

            messages.push({ role: 'function', content: error, name: result.function_call.name });
            const id = createTypingFunction(
                conversationId, assistantLlmId, undefined, 'function',
                error, undefined,
                result.function_call.name
            );
            editMessage(conversationId, id, { typing: false }, false);
            // throw new Error(`Unknown function name: ${result.function_call.name}`);
        } else {
            break; // non-function call
        }
    }
    if (autoTitleChat)
        autoTitle(conversationId);
}

import { speakText } from '~/modules/elevenlabs/elevenlabs.client';
import { streamChat } from '~/modules/llms/transports/streamChat';
import { ChatAutoSpeakType, getChatAutoAI } from '../store-app-chat';

async function streamAssistantMessage(
    llmId: DLLMId,
    messages: VChatMessageIn[],
    autoSpeak: ChatAutoSpeakType,
    editMessage: (updatedMessage: Partial<DMessage>) => void,
    abortSignal: AbortSignal,
    functions?: VChatFunctionIn[],
): Promise<void | OpenAIWire.ChatCompletion.ResponseFunctionCall> {

    // speak once
    let spokenText = '';
    let spokenLine = false;

    // const messages = history.map(({ role, text }) => ({ role, content: text })); // root repo converts DMessage to VChatMessageIn

    let res = undefined;
    try {
        res = await streamChat(llmId, messages, abortSignal,
            (updatedMessage: Partial<DMessage>) => {
                // update the message in the store (and thus schedule a re-render)
                editMessage(updatedMessage);

                // 📢 TTS: first-line
                if (updatedMessage?.text) {
                    spokenText = updatedMessage.text;
                    if (autoSpeak === 'firstLine' && !spokenLine) {
                        let cutPoint = spokenText.lastIndexOf('\n');
                        if (cutPoint < 0)
                            cutPoint = spokenText.lastIndexOf('. ');
                        if (cutPoint > 100 && cutPoint < 400) {
                            spokenLine = true;
                            const firstParagraph = spokenText.substring(0, cutPoint);

                            // fire/forget: we don't want to stall this loop
                            void speakText(firstParagraph);
                        }
                    }
                }
            },
            functions
        );
    } catch (error: any) {
        if (error?.name !== 'AbortError') {
            console.error('Fetch request error:', error);
            // TODO: show an error to the UI?
        }
    }

    // 📢 TTS: all
    if ((autoSpeak === 'all' || autoSpeak === 'firstLine') && spokenText && !spokenLine && !abortSignal.aborted)
        void speakText(spokenText);

    // finally, stop the typing animation
    editMessage({ typing: false });
    return res;
}