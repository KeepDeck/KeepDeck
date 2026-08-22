(()=>{const note=()=>{const n=document.createElement("div");
n.setAttribute("style","background:#fff;color:#000;padding:8px;position:fixed;bottom:0;left:0;right:0;z-index:9999");
n.textContent="This page's server went away — republish or reopen from the agent's message.";
document.body.appendChild(n);};
const es=new EventSource(location.pathname+"/events"+location.search);
es.addEventListener("version",()=>location.reload());
es.addEventListener("bye",()=>{es.close();note();});
es.addEventListener("error",()=>{es.close();note();});})();
