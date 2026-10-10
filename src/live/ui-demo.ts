export const DEMO_UI_SOURCE = `<div class="tabs">
  <button type="button" class="on" data-tab="visao">Visão</button>
  <button type="button" data-tab="dados">Dados</button>
  <button type="button" data-tab="mock">Mockup</button>
</div>
<section data-page="visao">
  <h2>Plano B · checkout</h2>
  <div class="metrics">
    <div class="metric"><b>12.4k</b><span>pedidos</span></div>
    <div class="metric"><b>4.1%</b><span>conversão</span></div>
    <div class="metric"><b>38s</b><span>tempo médio</span></div>
  </div>
  <div id="c1" class="ncli-chart-host"></div>
</section>
<section data-page="dados" hidden>
  <table>
    <thead><tr><th>Etapa</th><th>Status</th></tr></thead>
    <tbody>
      <tr><td>Carrinho</td><td><span class="badge ok">ok</span></td></tr>
      <tr><td>Frete</td><td><span class="badge warn">lento</span></td></tr>
      <tr><td>Pagamento</td><td><span class="badge bad">queda</span></td></tr>
    </tbody>
  </table>
  <p class="hint">Arraste para recortar a semana</p>
  <input type="range" min="2" max="7" value="7" id="cut">
  <p><button type="button" id="send">Pedir o plano B ao agente</button></p>
</section>
<section data-page="mock" hidden>
  <div class="gallery"><div class="ph"></div><div class="ph"></div><div class="ph"></div></div>
</section>
<script>
(function(){
  var tabs=document.querySelectorAll(".tabs button");
  var pages=document.querySelectorAll("[data-page]");
  tabs.forEach(function(b){b.onclick=function(){
    tabs.forEach(function(x){x.classList.toggle("on",x===b)});
    pages.forEach(function(p){p.hidden=p.getAttribute("data-page")!==b.getAttribute("data-tab")});
  }});
  var labels=["seg","ter","qua","qui","sex","sáb","dom"];
  var values=[8,11,9,14,18,12,16];
  function draw(n){ncliChart(document.getElementById("c1"),{type:"line",labels:labels.slice(0,n),values:values.slice(0,n)})}
  draw(7);
  var cut=document.getElementById("cut");
  if(cut) cut.oninput=function(){draw(+cut.value)};
  var send=document.getElementById("send");
  if(send) send.onclick=function(){ncliUi.send("segue no plano B do checkout")};
})();
</script>
`;

export function demoUiFence(): string {
  return `\`\`\`ncli ui\n${DEMO_UI_SOURCE.trim()}\n\`\`\``;
}
