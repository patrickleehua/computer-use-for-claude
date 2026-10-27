import vm from 'node:vm';

export function environment({ refuseFocus = false, missingCapability = false } = {}) {
  let nextTab = 100, nextWindow = 20;
  const tabs = new Map([[1, {id:1,windowId:1,url:'https://user.example/',active:true}]]);
  const windows = new Map([[1,{id:1,state:'maximized',focused:true}]]);
  const mutations = [], marks = [], programs = [];
  const copy = value => structuredClone(value);
  const focus = id => { for (const win of windows.values()) win.focused = !refuseFocus && win.id === id; };
  const management = {
    documentation: async () => 'Original management documentation',
    tabs: { query: async () => copy([...tabs.values()]), get: async id => { if (!tabs.has(id)) throw Error('No tab'); return copy(tabs.get(id)); } },
    windows: {
      get: async id => copy(windows.get(id)),
      create: async ({tabId,focused}) => {
        const tab = tabs.get(tabId); const id = nextWindow++;
        mutations.push({type:'move',tabId,windowId:id});
        tab.windowId = id; tab.active = true;
        windows.set(id,{id,state:'normal',focused:false});
        if (focused) focus(id);
        return copy(windows.get(id));
      },
      update: async (id, update) => { mutations.push({type:'focus',windowId:id}); if(update.state) windows.get(id).state=update.state; if(update.focused) focus(id); return copy(windows.get(id)); },
    },
  };
  const handle = id => ({id:String(id),markDeliverable:async()=>marks.push(id)});
  let context;
  function resetKernel() { context = vm.createContext({
    cua: {
      getBrowser: async () => ({browserId:'chrome',capabilities:{get:async()=>{if(missingCapability) throw Error('Unsupported capability'); return management;}}}),
      createBrowserTab: async (_browser,url) => {
        const id = nextTab++;
        tabs.set(id,{id,windowId:1,url,title:'Requested page',active:false});
        mutations.push({type:'create',tabId:id});
        return handle(id);
      },
      getTab: async id => { if(!tabs.has(Number(id))) throw Error('No tab'); return handle(Number(id)); },
    },
  }); }
  resetKernel();
  const invoke = async code => {
    programs.push(code);
    const content=[];
    context.nodeRepl = {write:value=>content.push({type:'text',text:String(value)})};
    // Model the original persistent top-level-await REPL's one var declaration.
    const declaration = /^var (\w+) = /.exec(code);
    if(declaration) vm.runInContext(`var ${declaration[1]};`,context);
    try { await vm.runInContext(`(async()=>{${declaration ? code.slice(4) : code}})()`,context); return {content}; }
    catch(error) { return {isError:true,content:[...content,{type:'text',text:error.message}]}; }
  };
  return {invoke,tabs,windows,mutations,marks,programs,resetKernel};
}
