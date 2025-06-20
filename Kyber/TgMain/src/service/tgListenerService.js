const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { Api } = require('telegram');
const { startRedis, redis } = require("../models/redisModel");
const axios = require('axios');
const {getAccountById,getReplyText,getLatestRegisterIds , getAccountByRegisterIdArray ,insertGroupChannel, getChatIdsByAccountInChannel, getChatIdsByAccountInMerchant, insertGroupMerchant, getChatIdsByChannelIdInChannel} = require("./tgDbService");

const orderContextMap = new Map();
let AccountId;
const AccountIdSet = new Set();
const clients = [];
const ErrorGroupChatID = -4750453063;

async function startOrderListener() {

  const registerId = await getLatestRegisterIds();
  const accountDetails = await getAccountByRegisterIdArray(registerId);


  const isMissingValues = accountDetails.some(account =>
    !account.session || !account.api_id || !account.api_hash
  );
  if (isMissingValues) {
    console.error(`[ERROR] 无法启动监听，registerId 数据不完整`);
    return;
  }

  for (const data of accountDetails) {
    const client = new TelegramClient(
      new StringSession(data.session),
      Number(data.api_id),
      data.api_hash,
      { connectionRetries: 5 }
    );

    await client.connect();
    console.log(`XXXClient connected: ${data.api_id}`);

    setupEventHandlers(client);


    // 防止退出
    setInterval(() => {}, 100000);

    clients.push({ id: data.Id, client });
  }

  console.log("All clients are connected and listening for events!");


  console.log('[Telegram] 已连接，监听开始...');

}

startOrderListener().catch(console.error);

function setupEventHandlers(client) {
  client.addEventHandler(async (event) => {

    const chatId = event.chatId?.valueOf();
    // Fetch chat details
    const chat = await client.getEntity(chatId);
    const chatTitle = chat.title;
    const message = event.message;
    const me = await event._client.getMe();
    const meId = String(me.id);
    // console.log(me.id); // Prints the ID
    const me2 = await client.getMe(); // Fetch your own account details
    // console.log(me2.id); // Log your user ID
    const sender = await event.message.senderId;
    const senderTelegramID = String(sender) ;

    // 标记渠道群 ID
    if (
      meId === senderTelegramID &&
      typeof message.message === 'string' &&
      message.message.startsWith('此群渠道群ID设为') &&
      message.message.includes("监听")
    ) {

      const match = message.message.match(/此群渠道群ID设为(\d+)由(.+?)监听/);
      if (match) {
        const channelId = match[1];
        AccountId = match[2];
        AccountIdSet.add(AccountId);
        await insertGroupChannel(AccountId, String(channelId), chatId, chatTitle, "channel", 1);
        await client.sendMessage(chatId, {
          message: `渠道群绑定成功：渠道Id = ${channelId}, 由 ${AccountId} 机器人监听`,
        });
        console.log(`[INFO] 渠道群 ${chatId} 已标记为 channelId ${channelId}, 由 ${AccountId} 机器人监听`);
      }
      return;
    }

    // 标记商户群
    if (
      meId === senderTelegramID &&
      typeof message.message === 'string' &&
      message.message.startsWith('此群标记为商户群') &&
      message.message.includes("监听")
    ) {
      const match = message.message.match(/由(.+?)监听/);
      if (match) {
        AccountId = match[1];
        AccountIdSet.add(AccountId);
        await insertGroupMerchant(AccountId, chatId, chatTitle, "merchant", 1);
        await client.sendMessage(chatId, {
          message: ` 当前群 ${chatId} 已标记为商户群, 由 ${AccountId} 机器人监听`
        });
        console.log(`[INFO] 群 ${chatId} 被标记为商户群, 由 ${AccountId} 机器人监听`);
      }
      return;
    }

    // 监听来源群
    if (
      // meId === senderTelegramID  &&
      message.media?.className === 'MessageMediaPhoto' &&
      typeof message.message === 'string' && // 图片附带的文字
      message.message.trim().length > 0
    ) {
      const sourceGroupIds = await getChatIdsByAccountInMerchant(AccountIdSet);
      if(sourceGroupIds.has(String(chatId))){

        const orderId = message.message.trim();
        console.log(`[INFO] 检测到订单号: ${orderId}，请求接口中...`);

        try {
          const response = await axios.get(`https://bi.humideah.com/bi/payin/check`, {
            params: { order_id: orderId }
          });

          const channelId = response.data?.channel_id || '未获得到渠道ID';
          const channelOrderId = response.data?.channel_order_id || '未获取到渠道单号';
          const targetChatIds = await getChatIdsByChannelIdInChannel(String(channelId));

          if (!targetChatIds.length) {
            console.warn(`[WARN] 未找到 channelId=${channelId} 对应的群`);
            await client.sendMessage(ErrorGroupChatID, { message: `[WARN] 未找到 channelId=${channelId} 对应的群` });
            return;
          }

          // 使用 sendFile 发送到目标群，并添加新的 caption
          for (const targetChatId of targetChatIds) {
            try {
              const sentMsg = await client.sendFile(targetChatId, {
                file: message.media,
                caption: `channelOrderId：${channelOrderId}`
              });
              console.log(`Sent to ${chatId}:`, sentMsg.id);
              // 保存上下文（单个订单用）
              orderContextMap.set(sentMsg.id, {
                orderId,
                originalMsgId: message.id,
                fromChat: chatId
              });
            } catch (error) {
              console.error(`Failed to send to ${chatId}:`, error.message);
            }
          }

          console.log(`[INFO] 渠道单号已发送至 目标群`);

        } catch (err) {
          console.error(`[ERROR] 请求接口失败:`, err.message);
        }
      }
    }

    // 渠道群回复监听 → 转发回商户群
    if (
      // meId === senderTelegramID  &&
      message.replyTo &&
      message.replyTo.replyToMsgId) {
      const channelGroupIds = await getChatIdsByAccountInChannel(AccountIdSet);
      if(channelGroupIds.has(String(chatId)) ){
        const replyToId = message.replyTo.replyToMsgId;
        const context = orderContextMap.get(replyToId);

        if (context) {
          const replyContent = message.text || '';
          const replyText = await getReplyText(replyContent);

          if (replyText === null) {

            await client.sendMessage(ErrorGroupChatID, {
              message: `語料庫沒有記錄`,
            });
          }

          await client.sendMessage(context.fromChat, {
            message: replyText !== null ? replyText : replyContent,
            replyTo: context.originalMsgId
          });

          console.log(`[INFO] 回复已转发回原群 ${context.fromChat} 并引用消息 ${context.originalMsgId}`);

          // 可选：清理上下文
          orderContextMap.delete(replyToId);
        } else {
          console.warn(`[WARN] 未找到关联上下文，replyToMsgId: ${replyToId}`);
        }
      }
    }
  }, new NewMessage({}));
}

async function stopListener(id) {
  const clientEntry = clients.find(entry => entry.id === id);
  if (!clientEntry) {
    console.warn(`No client found with id: ${id}`);
    return;
  }

  try {
    await clientEntry.client.disconnect();
    console.log(`Client manually disconnected: ${id}`);
    removeClientById(id);
  } catch (err) {
    console.error(`Failed to disconnect client with id ${id}:`, err);
  }
}


async function startListener(Id) {

  const data = await getAccountById(Id);

  const client = new TelegramClient(
    new StringSession(data.session),
    Number(data.api_id),
    data.api_hash,
    { connectionRetries: 5 }
  );

  await client.connect();
  console.log(`Client connected at runtime: ${data.api_id}`);

  setupEventHandlers(client, data.api_id);
  clients.push({ id: data.Id, client });
}

function removeClientById(id) {
  const index = clients.findIndex(entry => entry.id === id);
  if (index !== -1) {
    clients.splice(index, 1);
    console.log(`Client with ID ${id} removed from the list`);
  } else {
    console.warn(`No client found with ID ${id}`);
  }
}

module.exports = {
  startListener,
  stopListener
};