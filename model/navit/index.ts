import { Chat, ChatOptions, ChatRequest, ModelType } from '../base';
import { Event, EventStream, parseJSON, sleep } from '../../utils';
import {
  ChildOptions,
  ComChild,
  ComInfo,
  DestroyOptions,
  Pool,
} from '../../utils/pool';
import { Config } from '../../utils/config';
import { CreateAxiosProxy, CreateNewPage, WSS } from '../../utils/proxyAgent';
import { CreateEmail } from '../../utils/emailFactory';
import moment from 'moment/moment';
import { v4 } from 'uuid';
import { Page } from 'puppeteer';
import { AxiosInstance } from 'axios';

const ModelMap: Partial<Record<ModelType, number>> = {
  [ModelType.GPT4]: 112968,
  [ModelType.GPT3p5Turbo]: 112972,
};

interface Account extends ComInfo {
  email: string;
  password: string;
  left: number;
  refresh_time: number;
  uuid: string;
  token: string;
  created: number;
}

class Child extends ComChild<Account> {
  public client: AxiosInstance;
  public page?: Page;
  public wss!: WSS;
  private onData?: Function;

  constructor(label: string, info: any, options?: ChildOptions) {
    super(label, info, options);
    this.client = CreateAxiosProxy(
      {
        baseURL: 'https://api.navit.ai/',
      },
      false,
    );
  }

  createWSS() {
    this.wss = new WSS(`wss://api.navit.ai/api/ws?uuid=${this.info.uuid}`, {
      onOpen: () => {
        this.logger.info('wss connected');
      },
      onError: (err: any) => {
        this.logger.error('wss error, ', err);
        this.destroy({ delFile: false, delMem: true });
      },
      onClose: () => {
        this.destroy({ delFile: false, delMem: true });
      },
      onMessage: (msg) => {
        try {
          const data = parseJSON<{
            type: string;
            data: { message: string; name: string };
          }>(msg, {} as any);
          this.onData?.(data.type, data.data.name, data.data.message);
        } catch (e) {
          this.logger.error('onMessage failed, ', e);
        }
      },
    });
  }

  async init(): Promise<void> {
    if (this.info.token && this.info.uuid) {
      await this.updateQuota();
      this.createWSS();
      return;
    }
    try {
      let page;
      this.logger.info('register new account ...');
      page = await CreateNewPage('https://navit.ai/auth/login');
      this.page = page;

      await page.evaluate(() => {
        window.alert = () => {};
      });
      await page.waitForSelector('.el-input__inner');
      await page.click('.el-input__inner');
      const mailbox = CreateEmail(Config.config.navit.mailType);
      const email = await mailbox.getMailAddress();
      await page.keyboard.type(email);
      this.update({ email });

      await page.waitForSelector(
        '.page-main-body > .page-main-content > .el-form > div > .el-button',
      );
      await page.click(
        '.page-main-body > .page-main-content > .el-form > div > .el-button',
      );
      let verifyCode: string = '';
      for (const v of await mailbox.waitMails()) {
        verifyCode = (v as any).subject.match(/\d{6}/)?.[0] || '';
        if (verifyCode) {
          break;
        }
      }
      if (!verifyCode) {
        throw new Error('verifyCode not found');
      }
      await page.waitForSelector('.el-input__inner');
      await page.click('.el-input__inner');
      await page.keyboard.type(verifyCode);
      await page.waitForSelector(
        '.page-main-body > .page-main-content > .el-form > div > .el-button',
      );
      await page.click(
        '.page-main-body > .page-main-content > .el-form > div > .el-button',
      );
      await sleep(3 * 1000);
      const token = await this.getToken(page);
      this.update({ token });
      const user = await this.getUserInfo(page);
      this.update({ uuid: user.uuid, created: moment().unix() });
      await this.updateQuota();
      this.createWSS();
      page.browser().close();
    } catch (e) {
      throw e;
    }
  }

  async getToken(page: Page) {
    const token = await page.evaluate(() => localStorage.getItem('auth_token'));
    if (!token) {
      throw new Error('token not found');
    }
    return token;
  }

  async getUserInfo(page: Page) {
    const userStr = await page.evaluate(() => localStorage.getItem('user'));
    if (!userStr) {
      throw new Error('user not found');
    }
    const user = parseJSON<{ uuid: string }>(userStr, undefined as any);
    if (!user) {
      throw new Error('user parse failed');
    }
    return user;
  }

  async updateQuota() {
    const res: {
      data: { code: number; data: { quota: number; countdown: number } };
    } = await this.client.get(
      '/api/bots/limit/quota?bot_uuid=9675b1e8f62811eda0d10242ac130004',
      {
        headers: {
          Authorization: `Bearer ${this.info.token}`,
        },
      },
    );
    if (res.data.code !== 200) {
      throw new Error('get quota failed');
    }
    this.update({
      left: res.data.data.quota,
      refresh_time: moment().unix() + res.data.data.countdown / 1000,
    });
  }

  initFailed() {
    this.page?.browser().close();
    this.destroy({ delFile: true, delMem: true });
  }

  destroy(options?: DestroyOptions) {
    super.destroy(options);
    this.page?.browser()?.close();
  }

  sendMsg(
    content: string,
    model: ModelType,
    onData: (message: string) => void,
    onEnd: () => void,
    onError: (err: Error) => void,
  ) {
    const timeout = setTimeout(() => {
      onError(new Error('timeout'));
      this.onData = undefined;
    }, 10 * 1000);
    let old = '';
    this.onData = (t: string, name: string, message: string) => {
      switch (t) {
        case 'message':
          if (message.indexOf("I'm a limited access bot") > -1) {
            this.update({ left: 0 });
            onError(new Error('quota limit'));
            return;
          }
          if (message.length > old.length) {
            onData(message.substring(old.length));
            old = message;
          }
          timeout.refresh();
          return;
        case 'action':
          if (name === 'End') {
            if (model === ModelType.GPT4) {
              this.update({ left: this.info.left - 1 });
            }
            onEnd();
            this.logger.info('Recv msg ok');
            clearTimeout(timeout);
            this.clearContext(model);
            return;
          }
          return;
        default:
          break;
      }
    };
    this.wss.send(
      JSON.stringify({
        type: 'message',
        data: {
          conversation_id: ModelMap[model],
          type: 'text',
          content,
          sender_uuid: this.info.uuid,
          id: v4(),
        },
      }),
    );
  }

  clearContext(model: ModelType) {
    this.wss.send(
      JSON.stringify({
        type: 'message',
        data: {
          conversation_id: ModelMap[model],
          type: 'text',
          content: '/clear context',
          sender_uuid: '374f7a29-c194-45a9-9c01-e8c8965c412e',
          id: v4(),
        },
      }),
    );
  }
}

export class Navit extends Chat {
  private pool: Pool<Account, Child> = new Pool(
    this.options?.name || '',
    () => Config.config.navit.size,
    (info, options) => {
      return new Child(this.options?.name || '', info, options);
    },
    (v) => {
      if (!v.token || !v.uuid) {
        return false;
      }
      if (v.created + 30 * 24 * 60 * 60 < moment().unix()) {
        return false;
      }
      if (v.left <= 0 && v.refresh_time > moment().unix()) {
        return false;
      }
      return true;
    },
    { delay: 1000, serial: () => Config.config.navit.serial || 1 },
  );

  constructor(options?: ChatOptions) {
    super(options);
  }

  support(model: ModelType): number {
    switch (model) {
      case ModelType.GPT4:
        return 5000;
      case ModelType.GPT3p5_16k:
        return 13000;
      case ModelType.GPT3p5Turbo:
        return 3000;
      default:
        return 0;
    }
  }

  async preHandle(req: ChatRequest): Promise<ChatRequest> {
    return super.preHandle(req, {
      token: true,
      countPrompt: false,
      forceRemove: true,
    });
  }

  async askStream(req: ChatRequest, stream: EventStream): Promise<void> {
    const child = await this.pool.pop();
    if (!child) {
      stream.write(Event.error, { error: 'No valid connections', status: 429 });
      stream.write(Event.done, { content: '' });
      stream.end();
      return;
    }
    child.sendMsg(
      req.prompt,
      req.model,
      (content) => {
        stream.write(Event.message, { content });
      },
      () => {
        stream.write(Event.done, { content: '' });
        stream.end();
        child.release();
      },
      (err) => {
        stream.write(Event.error, { error: err.message });
        stream.write(Event.done, { content: '' });
        stream.end();
        child.destroy({ delFile: false, delMem: true });
      },
    );
  }
}
