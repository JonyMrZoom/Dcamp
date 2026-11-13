const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => [...root.querySelectorAll(sel)];
const money = value => new Intl.NumberFormat("ru-RU",{style:"currency",currency:"RUB",maximumFractionDigits:0}).format(Number(value||0));
const fmtDate = (value,short=false) => new Intl.DateTimeFormat("ru-RU",{day:"numeric",month:short?"short":"long",year:"numeric",timeZone:"Europe/Moscow"}).format(new Date(value+"T12:00:00"));
const rangeDate = s => {
  const a=new Date(s.start+"T12:00:00"),b=new Date(s.end+"T12:00:00");
  if(s.start===s.end)return fmtDate(s.start);
  if(a.getMonth()===b.getMonth())return `${a.getDate()}–${fmtDate(s.end)}`;
  return `${fmtDate(s.start)} — ${fmtDate(s.end)}`;
};
const esc = value => String(value??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
const plural = (n,forms) => {const x=Math.abs(n)%100,y=x%10;return x>10&&x<20?forms[2]:y>1&&y<5?forms[1]:y===1?forms[0]:forms[2];};
let shifts=[];
const dialog=$("#bookingDialog");
const state={step:1,shiftId:"",parentName:"",phone:"",email:"",children:[newChild()],transferRequested:false,transferNote:"",comment:"",consent:false,files:[]};
function newChild(){return {firstName:"",lastName:"",birthDate:"",coach:"",style:"",allergies:"",restrictions:"",certificate:null,certificateLater:false};}
function notify(message){
 const t=$("#toast");t.textContent=message;t.classList.add("show");
 clearTimeout(notify.timer);notify.timer=setTimeout(()=>t.classList.remove("show"),3200);
}
function available(s){return Number(s.available??(s.capacity-s.taken))>0&&s.open;}
function spotsText(s){const n=Number(s.available??(s.capacity-s.taken));return n>0?`Свободно ${n} ${plural(n,["место","места","мест"])}`:"Мест нет";}
function renderShifts(){
 const grid=$("#shiftGrid");
 if(!shifts.length){grid.innerHTML='<div class="shift-empty">Новые даты и смены скоро появятся. Следите за обновлениями или напишите организаторам.</div>';return;}
 grid.innerHTML=shifts.map((s,i)=>`<article class="shift-card">
   <div class="shift-card-top"><span class="shift-date">${esc(rangeDate(s))}</span><span class="shift-seats ${available(s)?"":"closed"}">${esc(spotsText(s))}</span></div>
   <p class="shift-type">ТАНЦЕВАЛЬНЫЙ ЛАГЕРЬ · ${esc(s.ages)} ЛЕТ</p>
   <h3>${esc(s.title)}</h3>
   <div class="shift-meta"><span>${esc(s.place||"Тюмень")}</span><span>${esc(s.styles?.join(" / ")||"Танцы и команда")}</span></div>
   <div class="shift-bottom"><div class="shift-price">${money(s.price)}<small>за ребёнка · вся смена</small></div>
   <button class="shift-open" data-shift-book="${esc(s.id)}" ${available(s)?"":"disabled"}>${available(s)?"Записаться":"Запись закрыта"} <span>↗</span></button></div>
 </article>`).join("");
}
async function loadShifts(){
 const grid=$("#shiftGrid");
 try{
  const response=await fetch("/api/public/shifts",{headers:{accept:"application/json"}});
  const data=await response.json();
  if(!response.ok||!data.ok)throw new Error(data.error||"Не удалось загрузить смены");
  shifts=data.shifts||[];renderShifts();
 }catch(error){
  grid.innerHTML=`<div class="shift-error"><b>Не удалось загрузить расписание</b><p>${esc(error.message)}. Проверьте подключение или попробуйте позже.</p><button class="button button-quiet" id="retryShifts">Повторить</button></div>`;
 }
}
function selectedShift(){return shifts.find(s=>s.id===state.shiftId);}
function openBooking(id=""){
 state.step=1;state.shiftId=id||shifts.find(available)?.id||"";
 state.children=[newChild()];state.parentName="";state.phone="";state.email="";state.transferRequested=false;state.transferNote="";state.comment="";state.consent=false;
 renderBooking();dialog.showModal();document.body.classList.add("dialog-open");
}
function closeBooking(){dialog.close();document.body.classList.remove("dialog-open");}
function shiftChoiceCard(s){
 const date=new Date(s.start+"T12:00:00");
 return `<button class="shift-choice" type="button" data-choose-shift="${esc(s.id)}" aria-pressed="${state.shiftId===s.id}">
  <span class="choice-date">${date.getDate()}<small>${new Intl.DateTimeFormat("ru-RU",{month:"short"}).format(date)}</small></span>
  <span class="choice-info"><b>${esc(s.title)}</b><small>${esc(rangeDate(s))} · ${esc(s.ages)} лет · ${esc(s.place||"Тюмень")}</small></span>
  <span class="choice-price">${money(s.price)}</span>
 </button>`;
}
function childCard(c,i){
 const styleOptions=["Брейкинг","All styles","Хип-хоп","Пока не определились"];
 return `<article class="child-card" data-child-index="${i}">
   <div class="child-card-head"><b>Участник 0${i+1}</b>${state.children.length>1?`<button class="remove-child" type="button" data-remove-child="${i}">Убрать</button>`:""}</div>
   <div class="field-grid">
    <div class="field"><label>Имя ребёнка</label><input name="firstName" value="${esc(c.firstName)}" autocomplete="off" placeholder="Имя" required></div>
    <div class="field"><label>Фамилия</label><input name="lastName" value="${esc(c.lastName)}" autocomplete="off" placeholder="Фамилия" required></div>
    <div class="field"><label>Дата рождения</label><input name="birthDate" type="date" value="${esc(c.birthDate)}" required></div>
    <div class="field"><label>Тренер (если есть)</label><input name="coach" value="${esc(c.coach)}" placeholder="Имя тренера"></div>
    <div class="field"><label>Направление</label><select name="style">${styleOptions.map(x=>`<option ${c.style===x?"selected":""} value="${esc(x)}">${esc(x)}</option>`).join("")}</select></div>
    <div class="field"><label>Аллергии</label><input name="allergies" value="${esc(c.allergies)}" placeholder="Нет / указать"></div>
   </div>
   <div class="field"><label>Ограничения и важные заметки</label><textarea name="restrictions" placeholder="Что важно знать команде лагеря">${esc(c.restrictions)}</textarea></div>
   <div class="field"><label>Свидетельство о рождении</label><input name="certificate" type="file" accept="image/jpeg,image/png,application/pdf"><span class="field-note">${c.certificate?esc(c.certificate.name):"Можно приложить сейчас или отправить администратору позже. JPG, PNG или PDF, до 5 МБ."}</span>
    <label class="consent-row"><input type="checkbox" name="certificateLater" ${c.certificateLater?"checked":""}><span>Пришлю документ позже</span></label>
   </div>
  </article>`;
}
function renderBooking(){
 const s=selectedShift();
 $("#stepLabel").textContent=["01 · СМЕНА","02 · АНКЕТА","03 · ПРОВЕРКА"][state.step-1];
 $("#stepCount").textContent=`${state.step} / 3`;
 $("#progressBar").style.width=(state.step/3*100)+"%";
 const back=$("#bookingBack"),next=$("#bookingNext");
 back.style.visibility=state.step===1?"hidden":"visible";
 next.innerHTML=state.step===3?'Отправить заявку <span>↗</span>':'Далее <span>→</span>';
 if(state.step===1){
  $("#bookingContent").innerHTML=`<p class="eyebrow dark">ШАГ 01 / ВЫБОР</p><h2 id="bookingTitle">ВЫБЕРИ<br>СВОЮ СМЕНУ.</h2><p class="booking-intro">Даты, возраст, стоимость и свободные места. Выбери подходящий заезд — дальше заполним анкету.</p>
  <div class="shift-choice-list">${shifts.filter(available).map(shiftChoiceCard).join("")||'<p class="field-note">Сейчас нет смен с открытой записью. Напишите организаторам, чтобы узнать о следующих датах.</p>'}</div>
  <p class="form-error" id="bookingError" hidden></p>`;
  next.disabled=!shifts.some(s=>s.id===state.shiftId&&available(s));
 }else if(state.step===2){
  $("#bookingContent").innerHTML=`<p class="eyebrow dark">ШАГ 02 / ДАННЫЕ</p><h2 id="bookingTitle">КТО ЕДЕТ<br>НА ДВИЖ?</h2><p class="booking-intro">Смена: <b>${esc(s?.title||"")}</b> · ${s?esc(rangeDate(s)):""} · ${s?money(s.price):""} за ребёнка. Заполни контакт родителя и карточку каждого участника.</p>
   <div class="field-grid">
    <div class="field"><label>Имя и фамилия родителя</label><input id="parentName" value="${esc(state.parentName)}" placeholder="Как к вам обращаться" required></div>
    <div class="field"><label>Телефон для связи</label><input id="parentPhone" type="tel" autocomplete="tel" value="${esc(state.phone)}" placeholder="+7 900 000-00-00" required></div>
    <div class="field"><label>Email (необязательно)</label><input id="parentEmail" type="email" value="${esc(state.email)}" placeholder="name@example.com"></div>
   </div>
   <div id="childrenList">${state.children.map(childCard).join("")}</div>
   <button class="add-child" type="button" id="addChild" ${state.children.length>=5?"disabled":""}>＋ Добавить ещё ребёнка</button>
   <label class="transfer-choice"><input id="transferRequested" type="checkbox" ${state.transferRequested?"checked":""}><span><b>Нужен трансфер</b><small>Отметьте, если ребёнку потребуется общий трансфер. Детали маршрута и время администратор подтвердит отдельно.</small></span></label>
   <div class="field"><label>Комментарий для организаторов</label><textarea id="bookingComment" placeholder="Пожелания по размещению, совместная поездка с другом и другое">${esc(state.comment)}</textarea></div>
   <p class="form-error" id="bookingError" hidden></p>`;
  next.disabled=false;
 }else{
  const kids=state.children.map(c=>`<div class="summary-row"><span>${esc(c.firstName)} ${esc(c.lastName)} · ${c.birthDate?fmtDate(c.birthDate):"дата рождения не указана"}</span><strong>${esc(c.style||"Направление не выбрано")}</strong></div>`).join("");
  $("#bookingContent").innerHTML=`<p class="eyebrow dark">ШАГ 03 / ПРОВЕРКА</p><h2 id="bookingTitle">ПОСЛЕДНИЙ<br>ЧЕК.</h2><p class="booking-intro">Проверь данные. Сейчас ты отправляешь бесплатную заявку на бронь — оплата на сайте не списывается.</p>
   <div class="booking-summary">
    <div class="summary-row"><span>Смена</span><strong>${esc(s?.title||"")}</strong></div>
    <div class="summary-row"><span>Даты</span><strong>${s?esc(rangeDate(s)):""}</strong></div>
    <div class="summary-row"><span>Родитель</span><strong>${esc(state.parentName)} · ${esc(state.phone)}</strong></div>
    ${kids}
    <div class="summary-row"><span>Трансфер</span><strong>${state.transferRequested?"Нужен":"Не нужен"}</strong></div>
    <div class="summary-total"><span>${state.children.length} ${plural(state.children.length,["РЕБЁНОК","РЕБЁНКА","ДЕТЕЙ"])}</span><strong>${money((s?.price||0)*state.children.length)}</strong></div>
   </div>
   <label class="consent-row"><input id="personalConsent" type="checkbox" ${state.consent?"checked":""}><span>Я согласен(на) на обработку персональных данных моих и ребёнка для оформления заявки. Перед запуском укажите ссылку на политику обработки персональных данных.</span></label>
   <p class="form-error" id="bookingError" hidden></p>`;
  next.disabled=false;
 }
}
async function collectChild(card,index){
 const get=name=>card.querySelector(`[name="${name}"]`);
 const c=state.children[index];
 c.firstName=get("firstName").value.trim();c.lastName=get("lastName").value.trim();c.birthDate=get("birthDate").value;
 c.coach=get("coach").value.trim();c.style=get("style").value;c.allergies=get("allergies").value.trim();
 c.restrictions=get("restrictions").value.trim();c.certificateLater=get("certificateLater").checked;
 const file=get("certificate").files[0];
 if(file){
  if(file.size>5*1024*1024)throw new Error(`${c.firstName||"Файл"}: свидетельство больше 5 МБ.`);
  c.certificate=await new Promise((resolve,reject)=>{
   const reader=new FileReader();reader.onload=()=>resolve({name:file.name,data:reader.result});reader.onerror=()=>reject(new Error("Не удалось прочитать файл"));
   reader.readAsDataURL(file);
  });
 }
}
function showBookingError(message){const el=$("#bookingError");if(el){el.hidden=false;el.textContent=message;}}
async function nextBookingStep(){
 const next=$("#bookingNext");next.disabled=true;
 try{
  if(state.step===1){
   if(!selectedShift()||!available(selectedShift()))throw new Error("Выбери смену с открытой записью.");
   state.step=2;renderBooking();return;
  }
  if(state.step===2){
   state.parentName=$("#parentName").value.trim();state.phone=$("#parentPhone").value.trim();state.email=$("#parentEmail").value.trim();
   state.transferRequested=$("#transferRequested").checked;state.comment=$("#bookingComment").value.trim();
   if(state.parentName.length<2)throw new Error("Укажи имя родителя.");
   if(state.phone.replace(/\D/g,"").length<10)throw new Error("Проверь номер телефона.");
   for(const card of $$(".child-card"))await collectChild(card,Number(card.dataset.childIndex));
   const s=selectedShift();
   for(const c of state.children){
    if(c.firstName.length<2||c.lastName.length<2||!c.birthDate)throw new Error("Заполни имя, фамилию и дату рождения каждого ребёнка.");
    const age=ageAt(c.birthDate,s.start);
    if(age<s.ageMin||age>s.ageMax)throw new Error(`${c.firstName}: возраст на начало смены должен быть от ${s.ageMin} до ${s.ageMax} лет.`);
   }
   state.step=3;renderBooking();return;
  }
  if(state.step===3){
   state.consent=$("#personalConsent").checked;
   if(!state.consent)throw new Error("Нужно согласие на обработку персональных данных.");
   await submitBooking();
  }
 }catch(error){showBookingError(error.message);}
 finally{if(dialog.open)next.disabled=false;}
}
function ageAt(birth,start){
 const b=new Date(birth+"T12:00:00"),s=new Date(start+"T12:00:00");let age=s.getFullYear()-b.getFullYear();
 if(s.getMonth()<b.getMonth()||(s.getMonth()===b.getMonth()&&s.getDate()<b.getDate()))age--;
 return age;
}
async function submitBooking(){
 const s=selectedShift(),next=$("#bookingNext");
 next.disabled=true;next.innerHTML="Отправляем…";
 try{
  const response=await fetch("/api/public/bookings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
   shiftId:s.id,parentName:state.parentName,phone:state.phone,email:state.email,
   transferRequested:state.transferRequested,transferNote:state.transferNote,comment:state.comment,consent:state.consent,
   children:state.children.map(c=>({firstName:c.firstName,lastName:c.lastName,birthDate:c.birthDate,coach:c.coach,style:c.style,allergies:c.allergies,restrictions:c.restrictions,certificate:c.certificate,certificateLater:c.certificateLater}))
  })});
  const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||"Не удалось отправить заявку");
  $("#bookingContent").innerHTML=`<div class="success-card"><div class="success-icon">✓</div><h2>ЗАЯВКА<br>ПРИНЯТА.</h2><p>Спасибо, ${esc(state.parentName)}! Заявка на смену «${esc(s.title)}» отправлена. Организатор свяжется с вами по указанному телефону и подтвердит бронь.</p><div class="success-code">${esc(data.booking.code)}</div><p>Сохраните номер заявки. Онлайн-оплата не проводилась. Все дальнейшие детали согласуем с вами лично.</p></div>`;
  $("#stepLabel").textContent="ГОТОВО";$("#stepCount").textContent="✓";$("#progressBar").style.width="100%";
  $("#bookingBack").style.visibility="hidden";next.disabled=false;next.innerHTML="Закрыть <span>×</span>";next.onclick=closeBooking;
  loadShifts();
 }catch(error){showBookingError(error.message);next.disabled=false;next.innerHTML="Повторить <span>↗</span>";}
}
$("#bookingNext").addEventListener("click",nextBookingStep);
$("#bookingBack").addEventListener("click",()=>{if(state.step>1){state.step--;renderBooking();}});
$("#bookingContent").addEventListener("click",e=>{
 const chosen=e.target.closest("[data-choose-shift]");if(chosen){state.shiftId=chosen.dataset.chooseShift;renderBooking();return;}
 if(e.target.closest("#addChild")){if(state.children.length>=5)return;state.children.push(newChild());renderBooking();return;}
 const remove=e.target.closest("[data-remove-child]");if(remove&&state.children.length>1){state.children.splice(Number(remove.dataset.removeChild),1);renderBooking();}
});
$("#bookingContent").addEventListener("change",e=>{
 if(e.target.matches('[name="certificate"]')){
  const card=e.target.closest(".child-card"),index=Number(card.dataset.childIndex),file=e.target.files[0];
  if(file&&file.size>5*1024*1024){e.target.value="";notify("Файл больше 5 МБ");return;}
  const note=card.querySelector(".field-note");if(note)note.textContent=file?file.name:"JPG, PNG или PDF, до 5 МБ.";
 }
});
document.addEventListener("click",e=>{
 if(e.target.closest("[data-book-open]")){e.preventDefault();openBooking();return;}
 const choose=e.target.closest("[data-shift-book]");if(choose){openBooking(choose.dataset.shiftBook);return;}
 if(e.target.closest("[data-book-close]"))closeBooking();
 if(e.target.id==="retryShifts")loadShifts();
});
dialog.addEventListener("click",e=>{if(e.target===dialog)closeBooking();});
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&dialog.open)closeBooking();});
const mobileMenu=$(".mobile-menu");
mobileMenu?.addEventListener("click",()=>{
 const nav=$(".main-nav"),opened=nav.classList.toggle("open");
 mobileMenu.setAttribute("aria-expanded",String(opened));mobileMenu.textContent=opened?"×":"☰";
});
$(".main-nav")?.addEventListener("click",e=>{if(e.target.closest("a")){$(".main-nav").classList.remove("open");mobileMenu.setAttribute("aria-expanded","false");mobileMenu.textContent="☰";}});
$("#bookingDialog")?.addEventListener("close",()=>{document.body.classList.remove("dialog-open");$("#bookingNext").onclick=null;$("#bookingNext").addEventListener("click",nextBookingStep);});
function ageAtClient(birth,start){return ageAt(birth,start);}
loadShifts();
