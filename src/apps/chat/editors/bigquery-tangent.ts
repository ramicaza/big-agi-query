import { DLLMId } from '~/modules/llms/store-llms';

import { SystemPurposeId } from '../../../data';

import { createDEphemeral, DMessage, useChatStore } from '~/common/state/store-chats';

import { createAssistantTypingMessage, createTypingFunction, updatePurposeInHistory } from './editors';

import { callChatGenerate, callChatGenerateWithFunctions, VChatMessageIn, VChatFunctionIn } from '~/modules/llms/transports/chatGenerate';

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

    const { appendEphemeral, updateEphemeralText, updateEphemeralState, deleteEphemeral, editMessage, deleteMessage } = useChatStore.getState();
    const assistantModelLabel = assistantLlmId;

    const messages = history.map(({ role, text, function_call, name }) => ({ role, content: text, function_call, name })) as VChatMessageIn[];

    // messages.push({ role: 'user', content: FunctionCallingPrompt }); // append a new message
    messages[messages.length - 1].content = `<user_message>${messages[messages.length - 1].content}}</user_message>

<note_to_you>
Given the above conversation/request, you must determine if you need to call a function to obtain 1 or more table schemas.
You should always look up a schema if you plan on using a table in a query.

If you need a schema, call the function. If you don't, then simply respond in english with "DONE: <short explanation of how you determined you didn't need to call a function>"
</note_to_you>`

    let gettingSchemaMsgId = null;
    for (let i = 0; i < 5; i++) {
        console.log('model INPUT:', JSON.parse(JSON.stringify(messages)));

        const assistantMessageId = createAssistantTypingMessage(conversationId, assistantModelLabel, undefined, '...');
        const result = await callChatGenerateWithFunctions(assistantLlmId,
            messages,
            // messages2,
            [func], null, 1000);
        console.log('model raw RESULT:', JSON.parse(JSON.stringify(result)));
        deleteMessage(conversationId, assistantMessageId);

        if (result.function_name && result.function_arguments && result.function_name === 'getTableSchema') {
            const { projectId, datasetId, tableId } = result.function_arguments as FuncArguments;
            const prettyTable = `${projectId ? projectId : ''}.${datasetId}.${tableId}`;
            console.log(`Requested SCHEMA for ${prettyTable}`);
            messages.push({ role: 'assistant', content: '', function_call: { name: result.function_name, arguments: result.function_arguments } });
            const gettingSchemaMsgId = createTypingFunction(
                conversationId, assistantModelLabel, undefined,
                'assistant', `Getting schema for ${prettyTable}`,
                { name: result.function_name, arguments: result.function_arguments });

            const res = await getTableSchema(projectId, datasetId, tableId);
            console.log('func call RESULT', res);
            // TODO: ramicaza check if json is the move here
            messages.push({ role: 'function', content: JSON.stringify(res), name: result.function_name });
            editMessage(conversationId, gettingSchemaMsgId, { typing: false }, false);

            const id = createTypingFunction(
                conversationId, assistantModelLabel, undefined, 'function',
                JSON.stringify(res), undefined,
                result.function_name
            );
            editMessage(conversationId, id, { typing: false }, false);
        } else if (result.function_name && result.function_name !== 'getTableSchema') {
            throw new Error('Unknown function name')
        } else {
            // console.log('non-function calling result:', result);
            console.log("Received non-function calling result, moving onto assistant reply");
            if (result.content.slice(0, 4) !== 'DONE') {
                console.warn('Finished function calling loop but did not receive DONE message');
            }
            messages.push({ role: 'assistant', content: result.content });
            messages.push({
                role: 'user',
                content: "<note_to_you>Now continue the conversation from before the function calls. Keep in mind the user can't see the raw json schemas</note_to_you>"
            });
            break;
        }
    }
    console.log('Continuing with assistant reply', messages);

    // Extract the new messages that were added in the loop
    // const newMessagesContent = messages.slice(history.length);

    // Convert the new message contents to DMessage objects
    // const newDMessages: DMessage[] = newMessagesContent.map((messageContent, index) => {
    //     // Create a unique id for the message - you might want to replace this with your actual id generation logic
    //     const messageId = `msg-${Date.now()}-${index}`;

    //     // Map the role to a sender string ('You', 'Bot', or other)
    //     let sender;
    //     switch (messageContent.role) {
    //         case 'assistant':
    //             sender = 'Bot';
    //             break;
    //         case 'user':
    //             sender = 'You';
    //             break;
    //         default:
    //             sender = messageContent.role; // Or any other default you want to use
    //     }

    //     // Create the DMessage object
    //     return {
    //         id: messageId,
    //         text: messageContent.content,
    //         sender: sender,
    //         avatar: null, // Set the avatar if available, otherwise null
    //         typing: false, // Assuming the message is not a 'typing' message
    //         role: messageContent.role,
    //         tokenCount: 0, // Set the token count if available, otherwise 0
    //         created: Date.now(),
    //         updated: null, // Set the updated timestamp if available, otherwise null
    //     };
    // });


    const assistantMessageId = createAssistantTypingMessage(conversationId, assistantModelLabel, undefined, '...');
    const controller = new AbortController();
    await streamAssistantMessage(assistantLlmId, messages, controller.signal, (updatedMessage) =>
        editMessage(conversationId, assistantMessageId, updatedMessage, false));

    // updateAssistantMessage({ text: result.content, typing: false });
    //   // create an ephemeral space
    //   const ephemeral = createDEphemeral(`Reason+Act`, 'Initializing ReAct..');
    //   appendEphemeral(conversationId, ephemeral);

    //   let ephemeralText = '';
    //   const logToEphemeral = (text: string) => {
    //     console.log(text);
    //     ephemeralText += (text.length > 300 ? text.slice(0, 300) + '...' : text) + '\n';
    //     updateEphemeralText(conversationId, ephemeral.id, ephemeralText);
    //   };

    //   try {

    //     // react loop
    //     const agent = new Agent();
    //     const reactResult = await agent.reAct(question, assistantLlmId, 5,
    //       logToEphemeral,
    //       (state: object) => updateEphemeralState(conversationId, ephemeral.id, state),
    //     );

    //     setTimeout(() => deleteEphemeral(conversationId, ephemeral.id), 2 * 1000);
    //     updateAssistantMessage({ text: reactResult, typing: false });

    //   } catch (error: any) {
    //     console.error(error);
    //     logToEphemeral(ephemeralText + `\nIssue: ${error || 'unknown'}`);
    //     updateAssistantMessage({ text: 'Issue: ReAct did not produce an answer.', typing: false });
    //   }
}

import { speakText } from '~/modules/elevenlabs/elevenlabs.client';
import { streamChat } from '~/modules/llms/transports/streamChat';
import { useElevenlabsStore } from '~/modules/elevenlabs/store-elevenlabs';

async function streamAssistantMessage(
    llmId: DLLMId,
    messages: VChatMessageIn[],
    abortSignal: AbortSignal,
    editMessage: (updatedMessage: Partial<DMessage>) => void,
) {

    // 📢 TTS: speak the first line, if configured
    const speakFirstLine = useElevenlabsStore.getState().elevenLabsAutoSpeak === 'firstLine';
    let firstLineSpoken = false;

    try {
        await streamChat(llmId, messages, abortSignal, (updatedMessage: Partial<DMessage>) => {
            // update the message in the store (and thus schedule a re-render)
            editMessage(updatedMessage);

            // 📢 TTS
            if (updatedMessage?.text && speakFirstLine && !firstLineSpoken) {
                let cutPoint = updatedMessage.text.lastIndexOf('\n');
                if (cutPoint < 0)
                    cutPoint = updatedMessage.text.lastIndexOf('. ');
                if (cutPoint > 100 && cutPoint < 400) {
                    firstLineSpoken = true;
                    const firstParagraph = updatedMessage.text.substring(0, cutPoint);
                    // fire/forget: we don't want to stall this loop
                    void speakText(firstParagraph);
                }
            }
        });
    } catch (error: any) {
        if (error?.name !== 'AbortError') {
            console.error('Fetch request error:', error);
            // TODO: show an error to the UI?
        }
    }

    // finally, stop the typing animation
    editMessage({ typing: false });
}