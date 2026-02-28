import { askText, askYesNo, printStep, printSuccess, printWarning, printError, printInfo } from '../prompts.js';
import { testDiscordToken, testTelegramToken } from '../connectivity.js';

export interface ChannelResult {
  enabled: boolean;
  token?: string;
  appToken?: string; // Slack only
  port?: number;     // Web only
  username?: string;  // Bot username from validation
}

export interface ChannelsStepResult {
  discord: ChannelResult;
  telegram: ChannelResult;
  slack: ChannelResult;
  whatsapp: ChannelResult;
  web: ChannelResult;
}

export async function runChannelsStep(): Promise<ChannelsStepResult> {
  printStep(3, 7, 'Channels');

  const result: ChannelsStepResult = {
    discord: { enabled: false },
    telegram: { enabled: false },
    slack: { enabled: false },
    whatsapp: { enabled: false },
    web: { enabled: false },
  };

  // Discord
  if (await askYesNo('Enable Discord?', false)) {
    result.discord.enabled = true;
    const token = await askText('Discord bot token');
    if (token) {
      result.discord.token = token;
      printInfo('Testing Discord token...');
      const test = await testDiscordToken(token);
      if (test.ok) {
        printSuccess(`Discord bot authenticated as: ${test.username}`);
        result.discord.username = test.username;
      } else {
        printError('Discord token validation failed — check the token');
      }
    }
  }

  // Telegram
  if (await askYesNo('Enable Telegram?', false)) {
    result.telegram.enabled = true;
    const token = await askText('Telegram bot token');
    if (token) {
      result.telegram.token = token;
      printInfo('Testing Telegram token...');
      const test = await testTelegramToken(token);
      if (test.ok) {
        printSuccess(`Telegram bot authenticated as: @${test.username}`);
        result.telegram.username = test.username;
      } else {
        printError('Telegram token validation failed — check the token');
      }
    }
  }

  // Slack
  if (await askYesNo('Enable Slack?', false)) {
    result.slack.enabled = true;
    result.slack.token = await askText('Slack bot token (xoxb-...)');
    result.slack.appToken = await askText('Slack app token (xapp-...)');
    printInfo('Slack tokens will be validated in the preflight check.');
  }

  // WhatsApp
  if (await askYesNo('Enable WhatsApp?', false)) {
    result.whatsapp.enabled = true;
    printInfo('No token needed — QR code pairing happens on first run.');
  }

  // Web
  if (await askYesNo('Enable Web interface?', true)) {
    result.web.enabled = true;
    const portStr = await askText('Web interface port', '3100');
    result.web.port = parseInt(portStr, 10) || 3100;
    printSuccess(`Web interface will run on port ${result.web.port}`);
  }

  // Summary
  const enabled = Object.entries(result)
    .filter(([, v]) => v.enabled)
    .map(([k]) => k);
  if (enabled.length) {
    printInfo(`\nEnabled channels: ${enabled.join(', ')}`);
  } else {
    printWarning('No channels enabled — you can enable them in the config later.');
  }

  return result;
}
