const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
const escapeHtml=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const money=v=>new Intl.NumberFormat("ru-RU",{style:"currency",currency:"RUB",maximumFractionDigits:0}).format(Number(v||0));
const date=v=>v?new Intl.DateTimeFormat("ru-RU",{day:"2-digit",month:"short",year:"numeric",timeZone:"Europe/Moscow"}).format(new Date(v)): "—";
const statuses={new:"Новая",confirmed:"Подтверждена",paid:"Оплачена",cancelled:"Отменена"};
let shifts=[],bookings=[],admin=null,editingShift=null,currentView="overview";
async function api(url,options={}){
 const response=await fetch(url,{credentials:"same-origin",...options,headers:{...(options.headers||{})}});
 const type=response.headers.get("content-type")||"";
 if(type.includes("application/json")){
  const data=await response.json();if(!response.ok||data.ok===false)throw new Error(data.error||"Ошибка сервера");return data;
 }
 if(!response.ok)throw new Error("Ошибка запроса: "+response.status);
 return response;
}
function toast(message){const t=$("#adminToast");t.textContent=message;t.classList.add("show");clearTimeout(toast.timer);toast.timer=setTimeout(()=>t.classList.remove("show"),3200);}
function showAuth(){ $("#authScreen").hidden=false;$("#adminApp").hidden=true;}
function showApp(){ $("#authScreen").hidden=true;$("#adminApp").hidden=false; }
async function checkSession(){
 try{const r=await api("/api/admin/me");admin=r.admin;$("#adminName").textContent=admin.name||admin.email;showApp();await initialize();}
 catch{showAuth();}
}
$("#loginForm").addEventListener("submit",async e=>{
 e.preventDefault();const error=$("#loginError"),button=$(".admin-primary",e.currentTarget);error.hidden=true;button.disabled=true;button.textContent="Проверяем…";
 try{
  const data=await api("/api/admin/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:e.currentTarget.email.value,password:e.currentTarget.password.value})});
  admin=data.admin;$("#adminName").textContent=admin.name||admin.email;showApp();await initialize();
 }catch(err){error.hidden=false;error.textContent=err.message;}
 finally{button.disabled=false;button.innerHTML='Войти в систему <span>↗</span>';}
});
$("#logoutButton").addEventListener("click",async()=>{try{await api("/api/admin/logout",{method:"POST"});}catch{}admin=null;showAuth();});
async function initialize(){await Promise.all([loadDashboard(),loadShifts(),loadBookings()]);renderTransfers();}
function setView(view){
 currentView=view;$$(".view-panel").forEach(p=>p.classList.toggle("active",p.id==="view-"+view));
 $$(".nav-item").forEach(b=>b.classList.toggle("active",b.dataset.view===view));
 const title={overview:"Обзор",shifts:"Смены",participants:"Участники",transfers:"Трансфер",migration:"Перенос данных"}[view]||"Обзор";
 $("#pageTitle").textContent=title;$("#breadcrumb").textContent="РАБОЧЕЕ ПРОСТРАНСТВО / "+title.toUpperCase();
 if(view==="participants")loadBookings();if(view==="transfers")renderTransfers();
}
document.addEventListener("click",e=>{
 const nav=e.target.closest("[data-view]");if(nav){setView(nav.dataset.view);return;}
 const go=e.target.closest("[data-go-view]");if(go){setView(go.dataset.goView);return;}
 if(e.target.closest("[data-new-shift]"))openShiftEditor();
 const edit=e.target.closest("[data-edit-shift]");if(edit)openShiftEditor(shifts.find(s=>s.id===edit.dataset.editShift));
 const del=e.target.closest("[data-delete-shift]");if(del)deleteShift(del.dataset.deleteShift);
 const close=e.target.closest("[data-close-editor]");if(close)$("#shiftEditor").close();
 const closeDetail=e.target.closest("[data-close-detail]");if(closeDetail)$("#bookingDetail").close();
 const detail=e.target.closest("[data-booking-detail]");if(detail){const booking=bookings.find(b=>b.id===detail.dataset.bookingDetail);if(booking)openBookingDetail(booking);return;}
 const roster=e.target.closest("[data-roster]");if(roster){$("#filterShift").value=roster.dataset.roster;setView("participants");loadBookings();}
 const transfer=e.target.closest("[data-transfer-export]");if(transfer)downloadExport(`/api/admin/exports/shifts/${transfer.dataset.transferExport}/transfer.docx`);
});
async function loadDashboard(){
 try{
  const {stats}=await api("/api/admin/dashboard");
  const metrics=[
   ["АКТИВНЫЕ СМЕНЫ",stats.activeShifts,"в расписании"],
   ["ЗАЯВОК",stats.bookings,"без отменённых"],
   ["УЧАСТНИКОВ",stats.participants,"в группах"],
   ["НУЖЕН ТРАНСФЕР",stats.transfers,"заявок"]
  ];
  $("#metricsGrid").innerHTML=metrics.map(([label,value,note])=>`<div class="metric"><small>${label}</small><strong>${Number(value).toLocaleString("ru-RU")}</strong><span>${note}</span></div>`).join("");
 }catch(e){$("#metricsGrid").innerHTML=`<div class="table-empty">${escapeHtml(e.message)}</div>`;}
}
async function loadShifts(){
 try{
  const data=await api("/api/admin/shifts");shifts=data.shifts||[];
  renderShifts();populateShiftOptions();
 }catch(e){toast(e.message);}
}
function renderShifts(){
 $("#adminShifts").innerHTML=shifts.length?shifts.map(s=>{
  const availability=Number(s.available??(s.capacity-s.taken));
  return `<article class="shift-admin-card">
   <div class="shift-admin-card-top"><span class="shift-date">${escapeHtml(date(s.start))} — ${escapeHtml(date(s.end))}</span><span class="status-pill ${s.open?"":"closed"}">${s.open?"Набор открыт":"Набор закрыт"}</span></div>
   <h3>${escapeHtml(s.title)}</h3><span class="shift-date">${escapeHtml(s.place||"Тюмень")} · ${escapeHtml(s.ages)} лет</span>
   <div class="shift-statline"><span><b>${s.taken}</b> / ${s.capacity} участников</span><span><b>${availability}</b> мест свободно</span><span><b>${money(s.price)}</b> / ребёнок</span></div>
   <div class="shift-admin-actions"><button data-edit-shift="${s.id}">Редактировать</button><button data-roster="${s.id}">Участники</button><button data-transfer-export="${s.id}">Трансфер DOCX</button><button data-delete-shift="${s.id}">Удалить</button></div>
  </article>`;
 }).join(""):'<div class="table-empty">Смен пока нет. Создайте первую, чтобы открыть набор на сайте.</div>';
 $("#overviewShifts").innerHTML=shifts.slice().sort((a,b)=>a.start.localeCompare(b.start)).slice(0,4).map(s=>`<div class="overview-shift"><div><b>${escapeHtml(s.title)}</b><small>${escapeHtml(date(s.start))} · ${s.taken} из ${s.capacity} мест</small></div><span class="overview-price">${money(s.price)}</span></div>`).join("");
}
function populateShiftOptions(){
 const filter=$("#filterShift"),current=filter.value;
 filter.innerHTML='<option value="">Все смены</option>'+shifts.map(s=>`<option value="${s.id}">${escapeHtml(s.title)}</option>`).join("");
 filter.value=shifts.some(s=>s.id===current)?current:"";
}
function openShiftEditor(shift=null){
 editingShift=shift;
 const form=$("#shiftForm");form.reset();
 $("#shiftEditorTitle").textContent=shift?"Редактировать смену":"Новая смена";
 $("#shiftEditorError").hidden=true;
 const set=(k,v)=>{if(form.elements[k])form.elements[k].value=v??"";};
 if(shift){
  set("title",shift.title);set("startDate",String(shift.start).slice(0,10));set("endDate",String(shift.end).slice(0,10));
  set("price",shift.price);set("capacity",shift.capacity);set("ageMin",shift.ageMin||String(shift.ages).match(/\d+/)?.[0]||7);
  set("ageMax",shift.ageMax||String(shift.ages).match(/\d+\D+(\d+)/)?.[1]||16);set("place",shift.place);
  set("coverUrl",shift.cover);set("shortDescription",shift.short);set("description",shift.description);
  set("styles",(shift.styles||[]).join("; "));set("coaches",(shift.coaches||[]).join("; "));
  set("groups",(shift.groups||[]).join("; "));set("program",(shift.program||[]).join("\n"));
  set("included",(shift.included||[]).join("\n"));set("transferInfo",shift.transferInfo);
  set("schedule",(shift.schedule||[]).join("\n"));form.elements.openForBooking.checked=shift.open;
  form.elements.published.checked=shift.published!==false;
 }else{
  const start=new Date();const finish=new Date(start);finish.setDate(finish.getDate()+3);
  set("startDate",start.toISOString().slice(0,10));set("endDate",finish.toISOString().slice(0,10));
  set("price",22000);set("capacity",40);set("ageMin",7);set("ageMax",16);set("place","Тюмень");
 }
 $("#shiftEditor").showModal();
}
const listValue=v=>String(v||"").split(/[;\n]/).map(x=>x.trim()).filter(Boolean);
$("#shiftForm").addEventListener("submit",async e=>{
 e.preventDefault();const form=e.currentTarget,body={
  title:form.elements.title.value.trim(),startDate:form.elements.startDate.value,endDate:form.elements.endDate.value,
  price:Number(form.elements.price.value),capacity:Number(form.elements.capacity.value),ageMin:Number(form.elements.ageMin.value),
  ageMax:Number(form.elements.ageMax.value),place:form.elements.place.value,coverUrl:form.elements.coverUrl.value,
  shortDescription:form.elements.shortDescription.value,description:form.elements.description.value,
  styles:listValue(form.elements.styles.value),coaches:listValue(form.elements.coaches.value),groups:listValue(form.elements.groups.value),
  program:listValue(form.elements.program.value),included:listValue(form.elements.included.value),transferInfo:form.elements.transferInfo.value,
  schedule:listValue(form.elements.schedule.value),openForBooking:form.elements.openForBooking.checked,published:form.elements.published.checked
 };
 const btn=$("#saveShiftButton"),error=$("#shiftEditorError");btn.disabled=true;btn.textContent="Сохраняем…";error.hidden=true;
 try{
  await api(editingShift?"/api/admin/shifts/"+editingShift.id:"/api/admin/shifts",{method:editingShift?"PATCH":"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  $("#shiftEditor").close();toast(editingShift?"Смена обновлена":"Смена создана");await loadShifts();await loadDashboard();
 }catch(err){error.hidden=false;error.textContent=err.message;}
 finally{btn.disabled=false;btn.textContent="Сохранить смену ↗";}
});
async function deleteShift(id){
 if(!confirm("Удалить смену? Если на неё есть заявки, удаление будет запрещено."))return;
 try{await api("/api/admin/shifts/"+id,{method:"DELETE"});toast("Смена удалена");await loadShifts();await loadDashboard();}
 catch(e){toast(e.message);}
}
let bookingLoadSeq=0;
async function loadBookings(){
 const seq=++bookingLoadSeq;const params=new URLSearchParams();
 if($("#filterShift").value)params.set("shiftId",$("#filterShift").value);
 if($("#filterStatus").value)params.set("status",$("#filterStatus").value);
 if($("#participantSearch").value.trim())params.set("q",$("#participantSearch").value.trim());
 try{
  const data=await api("/api/admin/bookings?"+params.toString());if(seq!==bookingLoadSeq)return;
  bookings=data.bookings||[];renderBookings();renderOverviewBookings();
 }catch(e){$("#participantRows").innerHTML=`<tr><td class="table-empty" colspan="6">${escapeHtml(e.message)}</td></tr>`;}
}
function childLabel(children){return (children||[]).map(c=>c.firstName+" "+c.lastName).join(", ");}
function openBookingDetail(b){
 const children=(b.children||[]).map(c=>'<article class="detail-child"><div><b>'+escapeHtml(c.firstName)+' '+escapeHtml(c.lastName)+'</b><small>'+escapeHtml(date(c.birthDate))+' · '+c.age+' лет</small></div>'
  +'<p><span>Тренер</span>'+escapeHtml(c.coach||"—")+'</p><p><span>Направление</span>'+escapeHtml(c.style||"—")+'</p>'
  +'<p><span>Аллергии</span>'+escapeHtml(c.allergies||"—")+'</p><p><span>Ограничения</span>'+escapeHtml(c.restrictions||"—")+'</p>'
  +'<p><span>Свидетельство</span>'+escapeHtml(({uploaded:"Загружено",send_later:"Пришлют позже",legacy_link:"Ссылка из старой базы",not_provided:"Не приложено"})[c.certificateStatus]||"—")+'</p>'
  +(c.documentId?'<button type="button" class="mini-link" data-download-document="'+c.documentId+'">Скачать документ ↗</button>':"")
  +(c.certificateLegacyUrl?'<a class="mini-link" href="'+escapeHtml(c.certificateLegacyUrl)+'" target="_blank" rel="noopener">Открыть документ из старой базы ↗</a>':"")
  +'</article>').join("");
 $("#bookingDetailTitle").textContent=b.code;
 $("#bookingDetailContent").innerHTML='<div class="detail-overview"><div><small>РОДИТЕЛЬ</small><b>'+escapeHtml(b.parent_name)+'</b><span>'+escapeHtml(b.phone)+'</span></div>'
  +'<div><small>СМЕНА</small><b>'+escapeHtml(b.shift_title)+'</b><span>'+escapeHtml(date(b.start_date))+' — '+escapeHtml(date(b.end_date))+'</span></div>'
  +'<div><small>СТАТУС</small><b>'+escapeHtml(statuses[b.status]||b.status)+'</b><span>'+(b.transfer_requested?"Трансфер нужен":"Без трансфера")+'</span></div></div>'
  +'<div class="detail-children"><p class="admin-eyebrow">УЧАСТНИКИ · '+(b.children||[]).length+'</p>'+children+'</div>'
  +(b.comment?'<div class="detail-note"><small>КОММЕНТАРИЙ</small><p>'+escapeHtml(b.comment)+'</p></div>':"")
  +(b.transfer_note?'<div class="detail-note"><small>ПО ТРАНСФЕРУ</small><p>'+escapeHtml(b.transfer_note)+'</p></div>':"");
 $("#bookingDetail").showModal();
}
function renderBookings(){
 const rows=$("#participantRows");
 if(!bookings.length){rows.innerHTML='<tr><td colspan="6" class="table-empty">По выбранным фильтрам заявок нет.</td></tr>';}
 else rows.innerHTML=bookings.map(b=>{
  const names=(b.children||[]).map(c=>`${escapeHtml(c.firstName)} ${escapeHtml(c.lastName)}`).join("<br>");
  const transfer=b.transfer_requested?'<span class="status-pill">НУЖЕН</span>':'<span>—</span>';
  return `<tr><td><div class="participant-name"><b>${names||"—"}</b><small>${escapeHtml(b.code)} · ${escapeHtml(date(b.created_at))}</small></div></td>
   <td>${escapeHtml(b.parent_name)}<br><small>${escapeHtml(b.phone)}</small></td>
   <td>${escapeHtml(b.shift_title)}</td><td>${transfer}</td>
   <td><select data-booking-status="${b.id}" aria-label="Статус заявки"><option value="new" ${b.status==="new"?"selected":""}>Новая</option><option value="confirmed" ${b.status==="confirmed"?"selected":""}>Подтверждена</option><option value="paid" ${b.status==="paid"?"selected":""}>Оплачена</option><option value="cancelled" ${b.status==="cancelled"?"selected":""}>Отменена</option></select></td>
   <td><button class="mini-link" data-booking-detail="${b.id}">Подробнее ↗</button></td></tr>`;
 }).join("");
 $("#participantsCount").textContent=`Показано заявок: ${bookings.length}`;
}
function renderOverviewBookings(){
 $("#overviewBookings").innerHTML=bookings.slice(0,5).map(b=>`<div class="overview-booking"><div><b>${escapeHtml(childLabel(b.children)||b.parent_name)}</b><small>${escapeHtml(b.shift_title)} · ${escapeHtml(b.parent_name)}</small></div><span class="status-pill ${b.status==="cancelled"?"closed":""}">${statuses[b.status]||b.status}</span></div>`).join("");
}
$("#participantSearch").addEventListener("input",debounce(loadBookings,220));
$("#filterShift").addEventListener("change",loadBookings);
$("#filterStatus").addEventListener("change",loadBookings);
document.addEventListener("change",async e=>{
 const sel=e.target.closest("[data-booking-status]");if(!sel)return;
 sel.disabled=true;
 try{await api("/api/admin/bookings/"+sel.dataset.bookingStatus+"/status",{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({status:sel.value})});toast("Статус заявки обновлён");await loadDashboard();await loadBookings();}
 catch(err){toast(err.message);await loadBookings();}
});
function debounce(fn,wait){let t;return(...args)=>{clearTimeout(t);t=setTimeout(()=>fn(...args),wait);};}
async function downloadExport(url){
 try{
  const response=await fetch(url,{credentials:"same-origin"});const type=response.headers.get("content-type")||"";
  if(!response.ok){const data=type.includes("application/json")?await response.json():null;throw new Error(data?.error||"Не удалось сформировать документ");}
  const blob=await response.blob(),disposition=response.headers.get("content-disposition")||"",match=disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const filename=match?decodeURIComponent(match[1]):(url.endsWith(".xlsx")?"participants.xlsx":"transfer.docx");
  const link=document.createElement("a"),objectUrl=URL.createObjectURL(blob);link.href=objectUrl;link.download=filename;document.body.append(link);link.click();link.remove();URL.revokeObjectURL(objectUrl);
  toast("Файл сформирован");
 }catch(error){toast(error.message);}
}
document.addEventListener("click",e=>{
 const b=e.target.closest("[data-download-document]");
 if(b)downloadExport("/api/admin/documents/"+b.dataset.downloadDocument);
});
$("#exportParticipants").addEventListener("click",()=>{
 const id=$("#filterShift").value;if(!id){toast("Выбери смену в фильтре выше");return;}
 downloadExport("/api/admin/exports/shifts/"+id+"/participants.xlsx");
});
$("#exportTransfer").addEventListener("click",()=>{
 const id=$("#filterShift").value;if(!id){toast("Выбери смену в фильтре выше");return;}
 downloadExport("/api/admin/exports/shifts/"+id+"/transfer.docx");
});
async function renderTransfers(){
 const el=$("#transferShifts");if(!el)return;
 if(!shifts.length){el.innerHTML='<div class="table-empty">Сначала добавьте смены.</div>';return;}
 try{
  const {bookings}=await api("/api/admin/bookings");
  const active=bookings.filter(b=>b.status!=="cancelled"&&b.transfer_requested);
  el.innerHTML=shifts.map(s=>{
   const people=active.filter(b=>b.shift_id===s.id).reduce((n,b)=>n+(b.children?.length||0),0);
   return `<article class="transfer-card"><h3>${escapeHtml(s.title)}</h3><p>${escapeHtml(date(s.start))} — ${escapeHtml(date(s.end))} · ${people} пассажиров</p><button class="admin-outline" data-transfer-export="${s.id}" ${people?"":"disabled"}>Сформировать Word ↗</button></article>`;
  }).join("");
 }catch(e){el.innerHTML=`<div class="table-empty">${escapeHtml(e.message)}</div>`;}
}
$("#migrationForm").addEventListener("submit",async e=>{
 e.preventDefault();const form=e.currentTarget,file=form.elements.workbook.files[0];if(!file)return;
 const button=$("#importButton"),result=$("#migrationResult");button.disabled=true;button.textContent="Переносим…";result.hidden=true;
 try{
  const body=new FormData();body.append("workbook",file);
  const data=await api("/api/admin/import/legacy-xlsx",{method:"POST",body});
  result.hidden=false;result.textContent=`Готово. Смен: ${data.shiftsImported}. Заявок и детей: ${data.bookingsImported}. Уже были в базе: ${data.duplicates}. Пропущено строк: ${data.skipped}.`;
  await initialize();
 }catch(err){result.hidden=false;result.textContent="Ошибка импорта: "+err.message;result.style.background="#f8e5df";result.style.color="#9a482f";}
 finally{button.disabled=false;button.textContent="Импортировать в облачную базу ↗";}
});
async function boot(){await checkSession();}
boot();
