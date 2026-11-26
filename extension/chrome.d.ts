declare namespace chrome {
  namespace sidePanel {
    function setPanelBehavior(options: {
      openPanelOnActionClick?: boolean;
    }): Promise<void>;
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
    const onInstalled: {
      addListener: (callback: () => void) => void;
    };
  }
}
