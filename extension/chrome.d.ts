declare namespace chrome {
  namespace sidePanel {
    function setPanelBehavior(options: {
      openPanelOnActionClick?: boolean;
    }): Promise<void>;
  }

  namespace action {
    const onClicked: {
      addListener: (callback: (tab: tabs.Tab) => void) => void;
    };
  }

  namespace tabs {
    interface Tab {
      id?: number;
      url?: string;
      title?: string;
    }

    function query(queryInfo: {
      active?: boolean;
      currentWindow?: boolean;
    }): Promise<Tab[]>;

    function sendMessage(tabId: number, message: unknown): Promise<unknown>;
  }

  namespace scripting {
    interface InjectionResult<T = unknown> {
      result?: T;
    }

    function executeScript<T = unknown>(injection: {
      target: { tabId: number };
      func: () => T;
    }): Promise<Array<InjectionResult<T>>>;
  }

  namespace runtime {
    function getURL(path: string): string;
    const onInstalled: {
      addListener: (callback: () => void) => void;
    };
    const onStartup: {
      addListener: (callback: () => void) => void;
    };
    const onMessage: {
      addListener: (
        callback: (
          message: unknown,
          sender: unknown,
          sendResponse: (response?: unknown) => void,
        ) => void,
      ) => void;
    };
  }

  namespace storage {
    const local: {
      get: (keys: string[]) => Promise<Record<string, unknown>>;
      set: (items: Record<string, unknown>) => Promise<void>;
    };
  }
}
