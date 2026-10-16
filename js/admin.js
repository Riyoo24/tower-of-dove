/* =====================================================================
   Tower of Dove Music Studio: owner and staff dashboard (pages/admin.html)
   Ported from the redesign reference. All data below is DEMO data.
   Owner sees every tab; staff do not see items marked data-owner.
   Replace the arrays (B, RN, STK, HC, P ...) with fetch() calls to your backend.
   ===================================================================== */
(function () {
// owner and staff only
const who = getUser();
if (!who || (who.role !== 'owner' && who.role !== 'staff')) {
  location.replace(ROOT + 'pages/login.html#login');
  return;
}
// pending-request badge next to "Rentals" in the sidebar
(() => { const l = document.querySelector('[data-side="a-rent"] .lbl');
  if (l) l.insertAdjacentHTML('beforeend', '<span class="cnt" id="rcnt" hidden></span>'); })();
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const ST=/^(Pending|Confirmed|Active|Completed|Rejected|Cancelled|Verified|Approved|In Use|Returned|Available|Occupied|Unavailable|Maintenance|Low|Overdue|Due today)$/;
const bd=s=>`<span class="b ${s.toLowerCase().replace(/ /g,'')}">${s}</span>`;
const tbl=(h,r)=>`<table><thead><tr>${h.map(x=>`<th>${x}</th>`).join('')}</tr></thead><tbody>${r.map(x=>`<tr>${x.map(c=>`<td>${ST.test(c)?bd(c):c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
const tb=(id,h,r)=>$('#'+id).innerHTML=tbl(h,r);
const mk=(id,h,r,si,t)=>{const el=$('#'+id),draw=f=>{el.innerHTML=`<div class="tabs">${t.map(x=>`<button class="${x==f?'on':''}" data-f="${x}">${x}</button>`).join('')}</div><div class="tw">${tbl(h,r.filter(x=>f=='All'||x[si]==f))}</div>`;el.querySelectorAll('.tabs button').forEach(b=>b.onclick=()=>draw(b.dataset.f))};draw('All')};
const A=(...l)=>l.map(x=>`<button class="btn sm ${x[0]=='!'?'line':''}">${x.replace('!','')}</button>`).join('');
const S=[['A','Drum and full band room',350,'Available','#C92C3E','#3D0C14'],['B','Vocal and acoustic booth',250,'Occupied','#C98512','#33220A'],['C','Mid-size band room',300,'Available','#8E161F','#1E0A0F'],['D','Production room',280,'Maintenance','#4A4A55','#16161A']];
const ph=s=>`<div class="ph" style="background:linear-gradient(135deg,${s[4]},${s[5]})">${s[0]}</div>`;
$('#ost').innerHTML=S.map(s=>`<div class="card"><div class="row"><h3><i class="lamp ${s[3]=='Occupied'?'live':''}"></i>Studio ${s[0]}</h3>${bd(s[3])}</div><p class="mut" style="margin-top:6px">${s[3]=='Occupied'?'Paolo Reyes, until 4:00 PM':s[3]=='Available'?'Next: 6:00 PM, Lunar Echo':'Back online Monday'}</p></div>`).join('');
$('#ast').innerHTML=S.map(s=>`<div class="card">${ph(s)}<div class="row"><h3>Studio ${s[0]}</h3>${bd(s[3])}</div><p class="mut">${s[1]}</p><div class="row" style="margin-top:8px"><b>₱${s[2]}/hr</b><span>${A('Edit','!Disable')}</span></div></div>`).join('');
const slots=['10:00 AM','11:00 AM','12:00 PM','1:00 PM','2:00 PM','3:00 PM','4:00 PM','5:00 PM','6:00 PM','7:00 PM','8:00 PM','9:00 PM'],taken=[3,4,8];
const SLOTS=slots;
const fm=n=>'₱'+n.toLocaleString('en-US');
const DS=(n,kit,vip,p)=>({n,cat:'Drums',a:p,o:p,s:1,ad:1,ou:1,d:{kit,vip}});
const CATS=['Guitars','Amplifiers','Drums','Keyboards','Effects','Accessories','Other'],MINRENT=8;
const E=[{n:'Electric guitar',cat:'Guitars',a:100,o:250,s:4,ad:1,ou:1},{n:'Guitar amplifier',cat:'Amplifiers',a:150,o:350,s:4,ad:1,ou:1},
DS('Set A Drum Set','RDX drum set',0,2700),DS('Set B Drum Set','RDX drum set',1,3000),DS('Set C Drum Set','Steely drum set (high-end model)',0,2500),DS('Set D Drum Set','Steely drum set (high-end model)',1,2800),
{n:'Drum kit add-ons',cat:'Drums',a:120,o:0,s:2,ad:1,ou:0},{n:'Keyboard',cat:'Keyboards',a:200,o:500,s:1,ad:1,ou:1},{n:'Multi-effects pedal',cat:'Effects',a:80,o:150,s:3,ad:1,ou:1}];
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
const PHICON='<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-8 8"/></svg>';
const eqImg=e=>e.img?`<div class="eqimg has"><img src="${esc(e.img)}" alt="${esc(e.n)}"></div>`:`<div class="eqimg" role="img" aria-label="No image yet">${PHICON}</div>`;
const descP=e=>e.desc?`<p class="mut" style="margin-top:4px">${esc(e.desc)}</p>`:'';
const landEq=()=>{},eqr=()=>{},renderBook=()=>{},rbkNoop=0;
const TY={a:'<span class="b addon">Add-on</span>',o:'<span class="b out">Outside</span>'},OUT=x=>'<b>'+x+'</b>';
const B=[['TOD-1042','Mika Santos','Studio A','Oct 10','2:00 PM','2 hrs','Confirmed','Verified'],['TOD-1043','Paolo Reyes','Studio B','Oct 9','1:00 PM','3 hrs','Active','Verified'],['TOD-1044','Lunar Echo (band)','Studio C','Oct 9','6:00 PM','2 hrs','Pending','Pending'],['TOD-1045','Jessa Cruz','Studio A','Oct 11','10:00 AM','1 hr','Pending','Pending'],['TOD-1046','Dan Villanueva','Studio D','Oct 8','4:00 PM','2 hrs','Completed','Verified'],['TOD-1047','Ana Lim','Studio B','Oct 12','3:00 PM','2 hrs','Cancelled','Rejected']];
var META={};function rbk(){
mk('abk',['Reference','Customer','Studio','Date','Time','Duration','Status','Payment','Actions'],B.map(b=>[...b,b[6]=='Pending'?A('Confirm','!Reject'):b[6]=='Confirmed'?A('!Details','!Cancel'):A('!Details')]),6,['All','Pending','Confirmed','Active','Completed','Cancelled']);
mk('apy',['Booking','Customer','Amount','Method','Reference','Status','Actions'],[['TOD-1044','Lunar Echo (band)','₱600','GCash','8841 220 3957','Pending',A('Verify','!Reject')],['TOD-1045','Jessa Cruz','₱350','Cash','Pay at studio','Pending',A('Verify','!Reject')],['TOD-1042','Mika Santos','₱700','GCash','8839 114 0271','Verified',A('!Details')],['TOD-1043','Paolo Reyes','₱750','Cash','Received by staff','Verified',A('!Details')],['TOD-1047','Ana Lim','₱500','GCash','8836 902 1184','Rejected',A('!Details')]].concat(PAYX()),5,['All','Pending','Verified','Rejected']);}rbk();
tb('acu',['Name','Phone','Account','Bookings','Rentals','Status',''],[['Mika Santos','0917 555 0142','Registered','12','4','Active',A('!History')],['Paolo Reyes','0918 555 0177','Registered','7','3','Active',A('!History')],['Lunar Echo (band)','0926 555 0103','Guest','2','1','Active',A('!History')],['Jessa Cruz','0905 555 0186','Guest','1','0','Active',A('!History')]]);
tb('stf',['Name','Role'],[['Studio Owner','Owner/Admin'],['Caretaker 1','Staff/Caretaker'],['Caretaker 2','Staff/Caretaker']]);
const V=[6,9,7,11,8,12,5],D=['Oct 3','4','5','6','7','8','9'];
$('#bars').innerHTML=V.map((v,i)=>`<div><i class="${i==6?'hi':''}" style="height:${v*9}px"></i>${v}<br>${D[i]}</div>`).join('');
const hb=(id,r)=>$('#'+id).innerHTML=r.map(x=>`<div class="hb"><div class="row" style="background:none;height:auto;margin:0"><span>${x[0]}</span><b>${x[1]}</b></div><div><i style="width:${x[2]}%"></i></div></div>`).join('');
const N=['Electric guitar','Guitar amplifier','Drum kit add-ons','Keyboard','Multi-effects pedal'],PR=[100,150,120,200,80],TOT=[6,5,2,4,3],AV=[4,4,2,1,3],SN=['A','B','C','D'];
const P={Today:{l:'today, Oct 9',s:[1,3,2,0],v:[700,750,600,0],r:[1,1,0,0,0],c:[1,4,1],f:.1,rn:[1,0]},Week:{l:'Oct 3 to Oct 9',s:[22,8,4,2],v:[6800,4900,5400,2100],r:[4,3,1,2,4],c:[5,19,7],f:.3,rn:[7,2]},Month:{l:'October 2026',s:[62,20,8,6],v:[18200,12500,14700,7000],r:[14,10,5,8,13],c:[18,52,21],f:1,rn:[19,4]},Custom:{l:'Sep 1 to Sep 30',s:[84,0,0,8],v:[17100,12900,13200,6400],r:[12,9,4,7,10],c:[14,47,19],f:.85,rn:[24,3]}};
const RT={Booking:'Total bookings, how many are confirmed, pending, completed or cancelled, and bookings per studio.',Sales:'Studio booking revenue plus equipment rental revenue, split by studio and by equipment.',Rental:'How often each item was rented and the income it earned.',Customer:'Customer counts (new, returning, guests) and how much each customer spent. Use View history to see spending on studio rooms and equipment.',Inventory:'Current stock for each item: available, in use and low stock. This is a snapshot, so the period filter does not apply.',Returns:'Rentals returned on time or late, and equipment that is overdue right now with how many days late.'};
const SL=['All studios','Studio A','Studio B','Studio C','Studio D'];
const FL={Booking:[SL,['All statuses','Pending','Confirmed','Completed','Cancelled']],Sales:[SL],Rental:[['All equipment',...N],['All rental statuses','Pending','Approved','In Use','Returned']],Customer:[],Inventory:[['All equipment',...N],['All stock levels','Available','Low']],Returns:[['All equipment',...N],['All return statuses','Due today','Overdue','Returned']]};
const TC=[['Mika Santos',12,8400],['Paolo Reyes',7,5250],['Lunar Echo (band)',5,3600],['Jessa Cruz',3,1050]];
const $n=n=>'₱'+n.toLocaleString('en-US'),sum=a=>a.reduce((x,y)=>x+y,0);
const K=(l,v)=>`<div class="card kpi"><span class="mut">${l}</span><div class="num" ${String(v).length>8?'style="font-size:22px;padding:6px 0"':''}>${v}</div></div>`;
const sl=a=>`<select style="max-width:190px" aria-label="${a[0]}">${a.map(x=>`<option>${x}</option>`).join('')}</select>`;
const hbs=(id,r)=>{const m=Math.max(...r.map(x=>x[2]),1);hb(id,r.map(x=>[x[0],x[1],Math.round(x[2]/m*100)]))};
const RG={Today:['2026-10-09','2026-10-09'],Week:['2026-10-03','2026-10-09'],Month:['2026-10-01','2026-10-31'],Custom:['2026-09-01','2026-09-30']};
const HC=[
['Mika Santos',[['TOD-1038','Studio A','2026-10-06',3,1050],['TOD-1031','Studio A','2026-10-02',2,700],['TOD-0988','Studio A','2026-09-14',2,700],['TOD-0975','Studio C','2026-09-05',2,600]],[['Keyboard',1,'2026-10-06',200],['Electric guitar',1,'2026-09-14',100]]],
['Paolo Reyes',[['TOD-1043','Studio B','2026-10-09',3,750],['TOD-1029','Studio B','2026-10-01',2,500],['TOD-0992','Studio B','2026-09-20',2,500]],[['Electric guitar',1,'2026-10-09',100],['Guitar amplifier',1,'2026-10-09',150],['Guitar amplifier',1,'2026-09-20',150]]],
['Lunar Echo (band)',[['TOD-1034','Studio C','2026-10-04',3,900],['TOD-0981','Studio C','2026-09-10',2,600],['TOD-0969','Studio A','2026-09-02',3,1050]],[['Multi-effects pedal',2,'2026-10-04',160],['Drum kit add-ons',1,'2026-09-10',120]]],
['Jessa Cruz',[['TOD-1036','Studio D','2026-10-05',2,560],['TOD-1020','Studio A','2026-09-28',1,350]],[]],
['Dan Villanueva',[['TOD-1046','Studio D','2026-10-08',2,560]],[['Multi-effects pedal',1,'2026-10-08',80]]]];
const fd=x=>new Date(x+'T00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'});
const cust=()=>{const [lo,hi]=RG[rp],ir=x=>x[2]>=lo&&x[2]<=hi;return HC.map(c=>{const s=c[1].filter(ir),q=c[2].filter(ir),ss=sum(s.map(x=>x[4])),qs=sum(q.map(x=>x[3]));return{n:c[0],s,q,ss,qs,t:ss+qs}}).filter(c=>c.t>0).sort((a,b)=>b.t-a.t)};
/* rentals: return dates and overdue tracking (today in this prototype = Oct 9, 2026) */
const TD='2026-10-09',dd=(a,b)=>Math.round((new Date(a+'T00:00')-new Date(b+'T00:00'))/864e5),pl=(n,w)=>n+' '+w+(n==1?'':'s');
/* [request, customer, equipment, qty, type a/o, booking or OUT id, status, return date, return label, date actually returned] */
const RN=[
['R-301','Paolo Reyes','Electric guitar',1,'a','TOD-1043','In Use','2026-10-09','Oct 9, 4:00 PM',null],
['R-302','Paolo Reyes','Guitar amplifier',1,'a','TOD-1043','In Use','2026-10-09','Oct 9, 4:00 PM',null],
['R-303','Mika Santos','Keyboard',1,'a','TOD-1042','Pending','2026-10-10','Oct 10, 4:00 PM',null],
['R-304','Lunar Echo (band)','Multi-effects pedal',2,'a','TOD-1044','Approved','2026-10-09','Oct 9, 8:00 PM',null],
['R-305','Jessa Cruz','Set B Drum Set',1,'o','OUT-2003','Approved','2026-10-13','Oct 13',null],
['R-306','Dan Villanueva','Guitar amplifier',1,'o','OUT-2002','In Use','2026-10-08','Oct 8',null],
['R-307','Ana Lim','Keyboard',1,'o','OUT-2004','Pending','2026-10-14','Oct 14',null],
['R-300','Mika Santos','Multi-effects pedal',1,'o','OUT-2000','In Use','2026-10-06','Oct 6',null],
['R-296','Lunar Echo (band)','Keyboard',1,'o','OUT-1999','In Use','2026-10-07','Oct 7',null],
['R-299','Dan Villanueva','Multi-effects pedal',1,'a','TOD-1046','Returned','2026-10-08','Oct 8, 6:00 PM','2026-10-08'],
['R-298','Mika Santos','Electric guitar',1,'o','OUT-2001','Returned','2026-10-07','Oct 7','2026-10-08'],
['R-297','Jessa Cruz','Keyboard',1,'o','OUT-2005','Returned','2026-10-09','Oct 9','2026-10-09'],
['R-295','Ana Lim','Set A Drum Set',1,'o','OUT-1998','Rejected','2026-10-06','Oct 6',null,'Equipment not available']];
const od=r=>r[6]=='In Use'&&r[7]<TD?dd(TD,r[7]):0,late=r=>r[9]&&r[9]>r[7]?dd(r[9],r[7]):0;
let OVD,DUE,RTD;const calc=()=>{OVD=RN.filter(r=>od(r)>0).sort((a,b)=>od(b)-od(a));DUE=RN.filter(r=>r[6]=='In Use'&&r[7]==TD);RTD=RN.filter(r=>r[9]==TD)};calc();
const dueB=r=>od(r)?`<span class="b overdue">${pl(od(r),'day')} overdue</span>`:r[6]=='Returned'?(late(r)?`<span class="b out">Returned ${pl(late(r),'day')} late</span>`:'<span class="mut">Returned on time</span>'):DUE.includes(r)?'<span class="b duetoday">Due today</span>':'<span class="mut">-</span>';
const RB=(a,id,t,l)=>`<button class="btn sm ${l?'line':''}" data-act="${a}" data-id="${id}">${t}</button>`,LK=id=>`<button class="lk" data-act="det" data-id="${id}">${id}</button>`;
const rAct=r=>r[6]=='Pending'?RB('approve',r[0],'Approve')+RB('reject',r[0],'Reject',1):r[6]=='Approved'?RB('issue',r[0],'Issue')+RB('det',r[0],'Details',1):r[6]=='In Use'?RB('return',r[0],'Process return')+(od(r)?RB('det',r[0],'Contact',1):''):RB('det',r[0],'Details',1);
const STK={},EQN=['Electric guitar','Guitar amplifier','Set A Drum Set','Set B Drum Set','Set C Drum Set','Set D Drum Set','Drum kit add-ons','Keyboard','Multi-effects pedal'];
[[6,4,2],[5,4,1],[1,1,0],[1,1,0],[1,1,0],[1,1,0],[2,2,0],[4,1,3],[3,3,0]].forEach((x,i)=>STK[EQN[i]]={t:x[0],a:x[1],u:x[2]});
const PH={'Mika Santos':'0917 555 0142','Paolo Reyes':'0918 555 0177','Lunar Echo (band)':'0926 555 0103','Jessa Cruz':'0905 555 0186'};
let rf='All';
const RF=['All','Pending','Approved','In Use','Due today','Overdue','Returned','Rejected'];

// ---- GROUPED RENTALS (Feature 5) ----
function getOrderKey(r){return r[4]=='a'?r[1]+'|'+r[5]:r[5]}
function getOrderGroups(rows){
  const map={},order=[];
  rows.forEach(r=>{const k=getOrderKey(r);if(!map[k]){map[k]={key:k,customer:r[1],type:r[4],id:r[5],items:[],status:null};order.push(k)}map[k].items.push(r)});
  order.forEach(k=>{const g=map[k],statuses=g.items.map(x=>x[6]);
    if(statuses.includes('Pending'))g.status='Pending';
    else if(statuses.includes('In Use'))g.status='In Use';
    else if(statuses.every(s=>s=='Returned'))g.status='Returned';
    else if(statuses.every(s=>s=='Rejected'))g.status='Rejected';
    else g.status=g.items[0][6]});
  return order.map(k=>map[k]);
}
function groupMatchesFilter(g,f){
  if(f=='All')return true;
  if(f=='Overdue')return g.items.some(r=>od(r)>0);
  if(f=='Due today')return g.items.some(r=>DUE.includes(r));
  return g.items.some(r=>r[6]==f);
}

function rnr(){
  const groups=getOrderGroups(RN).filter(g=>groupMatchesFilter(g,rf));
  if(rf=='Overdue')groups.sort((a,b)=>Math.max(...b.items.map(od))-Math.max(...a.items.map(od)));
  let rows=groups.map(g=>{
    const icount=g.items.length;
    const itemsLabel=icount==1?g.items[0][2]+' x'+g.items[0][3]:icount+' items';
    const retLabel=g.items.map(r=>r[8]).filter((v,i,a)=>a.indexOf(v)==i).join(', ');
    return `<tr data-gk="${encodeURIComponent(g.key)}"><td><button class="lk" data-gdet="${encodeURIComponent(g.key)}">${g.type=='a'?g.id:g.id}</button></td><td>${g.customer}</td><td>${itemsLabel}</td><td>${g.type=='a'?TY.a:TY.o}</td><td>${g.status=='Pending'?bd('Pending'):g.status=='In Use'?bd('In Use'):g.status=='Returned'?bd('Returned'):g.status=='Rejected'?bd('Rejected'):g.status}</td><td><button class="btn sm line" data-gdet="${encodeURIComponent(g.key)}">Details</button></td></tr>`;
  });
  $('#arn').innerHTML=`<div class="tabs">${RF.map(x=>`<button data-f="${x}" class="${x==rf?'on':''}">${x}${x=='Overdue'?' ('+OVD.length+')':x=='Pending'?' ('+RN.filter(r=>r[6]=='Pending').length+')':''}</button>`).join('')}</div><div class="card"><div class="tw"><table><thead><tr><th>Order</th><th>Customer</th><th>Items</th><th>Rent type</th><th>Status</th><th>Actions</th></tr></thead><tbody id="rn-body">${rows.join('')}</tbody></table></div></div>`;
  $('#arn').querySelectorAll('.tabs button').forEach(b=>b.onclick=()=>{rf=b.dataset.f;rnr()});
  $('#arn').querySelectorAll('[data-gdet]').forEach(btn=>{btn.onclick=()=>{const gk=decodeURIComponent(btn.dataset.gdet);toggleGroupExpand(gk)}});
}

function toggleGroupExpand(gk){
  const row=$('#rn-body tr[data-gk="'+encodeURIComponent(gk)+'"]');if(!row)return;
  const next=row.nextElementSibling;
  if(next&&next.classList.contains('expand-row')){next.remove();return}
  const g=getOrderGroups(RN).find(x=>x.key==gk);if(!g)return;
  const sub=document.createElement('tr');sub.className='expand-row';
  sub.innerHTML=`<td colspan="6"><div class="sub-tbl"><table><thead><tr><th>Request</th><th>Equipment</th><th>Qty</th><th>Return date</th><th>Status</th><th>Overdue</th><th>Actions</th></tr></thead><tbody>${g.items.map(r=>`<tr><td>${r[0]}</td><td>${r[2]}</td><td>${r[3]}</td><td>${r[8]}</td><td>${r[6]}</td><td>${dueB(r)}</td><td>${rAct(r)}</td></tr>`).join('')}</tbody></table></div></td>`;
  row.after(sub);
  sub.querySelectorAll('[data-act]').forEach(b=>{b.onclick=()=>{const a=b.dataset.act,id=b.dataset.id;if(a=='det')rdlg(id);else if(a=='reject')rdlg(id,1);else{act(a,id)}}});
}

const toast=m=>{const t=$('#toast');t.textContent=m;t.hidden=false;clearTimeout(toast.h);toast.h=setTimeout(()=>t.hidden=true,4000)};
function rdlg(id,focusReject){
 const r=RN.find(x=>x[0]==id),k=STK[r[2]],ok=k&&k.a>=r[3],st=r[6];
 let h=`<div class="in"><div class="row"><h2 style="margin:0">Rental ${r[0]}</h2>${bd(st)}</div><dl class="dl"><dt>Customer</dt><dd>${r[1]}</dd><dt>Phone</dt><dd>${PH[r[1]]||'Not on file'}</dd><dt>Equipment</dt><dd>${r[2]} x ${r[3]}</dd><dt>Rent type</dt><dd>${r[4]=='a'?TY.a:TY.o}</dd><dt>${r[4]=='a'?'Booking':'Outside ID'}</dt><dd>${r[4]=='a'?r[5]:OUT(r[5])}</dd><dt>Return by</dt><dd>${r[8]}</dd><dt>Stock now</dt><dd>${k?k.a+' of '+k.t+' available':'-'}</dd>${r[9]?'<dt>Returned</dt><dd>'+fd(r[9])+(late(r)?' ('+pl(late(r),'day')+' late)':'')+'</dd>':''}${r[10]?'<dt>Reason</dt><dd>'+r[10]+'</dd>':''}</dl>`;
 if(od(r))h+=`<div class="alert">${pl(od(r),'day')} overdue. Contact the customer to arrange the return.</div>`;
 if(st=='Pending'){
  if(!ok)h+=`<div class="alert">Only ${k?k.a:0} available. This request needs ${r[3]}, so it can't be approved until stock comes back.</div>`;
  h+=`<label for="rrs">Reason if rejecting (the customer sees this)</label><select id="rrs"><option>Equipment not available</option><option>Studio booking not confirmed</option><option>Incomplete or unclear request</option><option>Other</option></select><div id="rrs-other-wrap" hidden><label for="rrs-other">Message to customer</label><input id="rrs-other" maxlength="300" placeholder="Describe the reason (customer will see this)"></div><div class="acts"><button class="btn line" data-do="close">Close</button><button class="btn bad" data-do="reject" data-id="${id}">Reject rental</button><button class="btn gold" data-do="approve" data-id="${id}" ${ok?'':'disabled'}>Approve rental</button></div>`}
 else if(st=='Approved')h+=`<div class="acts"><button class="btn line" data-do="close">Close</button><button class="btn gold" data-do="issue" data-id="${id}">Issue equipment</button></div>`;
 else if(st=='In Use')h+=`<div class="acts"><button class="btn line" data-do="close">Close</button><button class="btn gold" data-do="return" data-id="${id}">Process return</button></div>`;
 else h+=`<div class="acts"><button class="btn line" data-do="close">Close</button></div>`;
 $('#rdlg').innerHTML=h+'</div>';$('#rdlg').showModal();if(focusReject&&$('#rrs'))$('#rrs').focus();
 // Feature 6: Other option in reject dialog
 const rrsEl=$('#rrs');if(rrsEl){rrsEl.onchange=()=>{const ow=$('#rrs-other-wrap');if(ow)ow.hidden=rrsEl.value!='Other'}}
}
function act(a,id){const r=RN.find(x=>x[0]==id),k=STK[r[2]];let m='';
 if(a=='approve'){if(!k||k.a<r[3]){rdlg(id);return}r[6]='Approved';k.a-=r[3];k.u+=r[3];m=id+' approved. '+r[2]+': '+k.a+' left to rent.'}
 else if(a=='reject'){
   const rs=$('#rrs');
   let reason=rs?rs.value:'Rejected by staff';
   if(reason=='Other'){const ot=$('#rrs-other');reason=ot&&ot.value.trim()?ot.value.trim():'Other'}
   r[6]='Rejected';r[10]=reason;m=id+' rejected. The customer will see: '+r[10]+'.'}
 else if(a=='issue'){r[6]='In Use';m=id+' issued to '+r[1]+'.'}
 else if(a=='return'){r[6]='Returned';r[9]=TD;if(k){k.a+=r[3];k.u-=r[3]}m=id+' returned. '+r[2]+' is back in stock.'}
 if($('#rdlg').open)$('#rdlg').close();rupd();toast(m)}
$('#rdlg').addEventListener('click',e=>{if(e.target.id=='rdlg')return $('#rdlg').close();const b=e.target.closest('[data-do]');if(!b)return;if(b.dataset.do=='close')$('#rdlg').close();else act(b.dataset.do,b.dataset.id)});
$('#arn').addEventListener('click',e=>{const t=e.target.closest('.tabs button');if(t){rf=t.dataset.f;rnr();return}});
function syncCat(){E.forEach(e=>{const k=STK[e.n];if(k)e.s=k.a});landEq();eqr()}
const thumb=c=>c.img?`<div class="eqthumb has"><img src="${esc(c.img)}" alt="${esc(c.n)}"></div>`:`<div class="eqthumb" role="img" aria-label="No image yet">${PHICON}</div>`;
const priceTxt=(c,m)=>(m=='a'?!c.ad:!c.ou)?'Not offered':fm(m=='a'?c.a:c.o)+(c.d?'/rental':m=='a'?'/session':'/day');
const chips=(c,i)=>`<div class="stk"><button class="chip ${c.ad?'on':''}" aria-pressed="${!!c.ad}" data-eqc="${i}:ad">Add-on</button><button class="chip ${c.ou?'on':''}" aria-pressed="${!!c.ou}" data-eqc="${i}:ou">Outside</button></div>`;
function aeqr(){
 const low=[];
 tb('aeq',['Equipment','Category','Total','Avail.','In use','Add-on price','Outside price','Rent options','Status',''],E.map((c,i)=>{
  const k=STK[c.n],s=k.a==0?'In Use':(k.a==1&&k.t>1?'Low':'Available');
  if(s!='Available')low.push(c.n+(s=='In Use'?' (none left)':''));
  const sub=c.d?esc(c.d.kit.replace(/ drum set.*/i,''))+', '+(c.d.vip?'VIP':'Basic')+' set-up, 8 hrs minimum':(c.desc?esc(c.desc):'');
  const nm=(c.d?'<b>'+esc(c.n)+'</b>':esc(c.n))+(sub?'<div class="mut eqd">'+sub+'</div>':'');
  return ['<div class="eqc">'+thumb(c)+'<div>'+nm+'</div></div>',esc(c.cat||'Other'),String(k.t),String(k.a),String(k.u),priceTxt(c,'a'),priceTxt(c,'o'),chips(c,i),s,'<div class="stk"><button class="btn sm" data-eqe="'+i+'">Edit</button><button class="btn sm line">Stock</button></div>']}));
 const nl=$('#nlow');if(nl)nl.textContent=low.join(', ')||'None';
}
function readImg(file,cb){const fr=new FileReader();
 fr.onerror=()=>cb(null);
 fr.onload=()=>{const im=new Image();im.onerror=()=>cb(null);
  im.onload=()=>{const r=Math.min(1,480/Math.max(im.width,im.height)),cv=document.createElement('canvas');cv.width=Math.max(1,Math.round(im.width*r));cv.height=Math.max(1,Math.round(im.height*r));
   const g=cv.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,cv.width,cv.height);g.drawImage(im,0,0,cv.width,cv.height);cb(cv.toDataURL('image/jpeg',.82))};
  im.src=fr.result};
 fr.readAsDataURL(file)}
function eqForm(i){
 const isNew=i==null,c=isNew?{n:'',cat:'',desc:'',a:0,o:0,ad:1,ou:1}:E[i],k=isNew?{t:1,u:0}:STK[c.n],drum=!!c.d,dlg=$('#eqdlg');
 let img=c.img||'',ad=!!c.ad,ou=!!c.ou;
 dlg.innerHTML=`<div class="in"><form id="eqf" novalidate>
  <h2 style="margin:0 0 4px">${isNew?'Add equipment':'Edit equipment'}</h2>
  <p class="mut">${isNew?'New items show up on the landing and customer pages.':'Changes show up on the landing and customer pages.'}</p>
  <label for="eqn">Equipment name</label><input id="eqn" value="${esc(c.n)}" placeholder="e.g. Bass guitar" ${isNew?'':'readonly'}>
  <label for="eqc">Category</label><select id="eqc"><option value="" disabled ${c.cat?'':'selected'}>Select a category</option>${CATS.map(x=>`<option ${x==c.cat?'selected':''}>${x}</option>`).join('')}</select>
  <label for="eqd">Description / specification</label><textarea id="eqd" rows="3" maxlength="300" placeholder="e.g. 4-string, active pickups. Includes cable and strap.">${esc(c.desc||'')}</textarea>
  <p class="mut" style="margin-top:4px">Optional. Customers see this on the equipment cards.</p>
  <div class="fg" style="grid-template-columns:repeat(${drum?2:3},minmax(0,1fr))">
   <div><label for="eqt">Total stock</label><input id="eqt" type="number" min="0" step="1" value="${k.t}"></div>
   ${drum?`<div><label for="eqa">Price per rental (₱)</label><input id="eqa" type="number" min="0" step="1" value="${c.a}"></div>`
   :`<div><label for="eqa">Add-on price (₱)</label><input id="eqa" type="number" min="0" step="1" value="${c.a}"></div><div><label for="eqo">Outside price (₱)</label><input id="eqo" type="number" min="0" step="1" value="${c.o}"></div>`}
  </div>
  <p class="mut" style="margin-top:6px">${drum?'Priced per rental.':'Add-on is per session. Outside is per day.'}</p>
  <div class="fg" style="grid-template-columns:repeat(2,minmax(0,1fr))">
   <div><label>Rent options</label><div><button type="button" class="chip ${ad?'on':''}" id="eqx-ad" aria-pressed="${ad}">Add-on</button><button type="button" class="chip ${ou?'on':''}" id="eqx-ou" aria-pressed="${ou}">Outside</button></div></div>
   <div><label for="eqm">Minimum rent</label><input id="eqm" value="${MINRENT} hours" readonly></div>
  </div>
  <p class="mut" style="margin-top:6px">The ${MINRENT}-hour minimum applies to outside rentals and drum sets.</p>
  <label>Equipment image</label>
  <div class="eqimg prev" id="eq-prev"></div>
  <input id="eq-file" type="file" accept="image/*" aria-label="Attach an image">
  <label for="eq-url" style="margin-top:14px">Or paste an image link</label>
  <div class="row" style="gap:8px"><input id="eq-url" placeholder="https://example.com/photo.jpg"><button type="button" class="btn sm line" id="eq-use" style="margin:0;white-space:nowrap">Use link</button></div>
  <div class="alert" id="eqerr" hidden></div>
  <div class="acts"><button type="button" class="btn line" id="eq-rm" style="margin-right:auto">Remove image</button><button type="button" class="btn line" id="eq-cancel">Cancel</button><button type="submit" class="btn gold">${isNew?'Add equipment':'Save changes'}</button></div>
 </form></div>`;
 const err=m=>{const e=$('#eqerr');e.textContent=m;e.hidden=!m};
 const prev=()=>{const p=$('#eq-prev');p.className='eqimg prev'+(img?' has':'');p.innerHTML=img?'<img src="'+esc(img)+'" alt="Image preview">':PHICON+'<span>No image yet</span>';
  const im=p.querySelector('img');if(im)im.onerror=()=>{img='';prev();err('That link could not be loaded as an image.')}};
 const useUrl=()=>{const v=$('#eq-url').value.trim();err('');if(!v)return true;
  if(!/^https?:\/\//i.test(v)){err('Enter a full link that starts with http:// or https://');return false}
  img=v;$('#eq-file').value='';prev();return true};
 prev();
 $('#eq-file').onchange=ev=>{const f=ev.target.files[0];if(!f)return;err('');
  if(!/^image\//.test(f.type)){err('Please choose an image file (JPG, PNG or WebP).');ev.target.value='';return}
  readImg(f,d=>{if(!d){err('That file could not be read as an image.');return}img=d;$('#eq-url').value='';prev()})};
 $('#eq-use').onclick=useUrl;
 $('#eq-url').onkeydown=ev=>{if(ev.key=='Enter'){ev.preventDefault();useUrl()}};
 $('#eq-rm').onclick=()=>{img='';$('#eq-file').value='';$('#eq-url').value='';err('');prev()};
 $('#eqx-ad').onclick=ev=>{ad=!ad;ev.target.classList.toggle('on',ad);ev.target.setAttribute('aria-pressed',ad)};
 $('#eqx-ou').onclick=ev=>{ou=!ou;ev.target.classList.toggle('on',ou);ev.target.setAttribute('aria-pressed',ou)};
 $('#eq-cancel').onclick=()=>dlg.close();
 $('#eqf').onsubmit=ev=>{ev.preventDefault();
  const typed=$('#eq-url').value.trim();if(typed&&typed!=img&&!useUrl())return;
  const n=$('#eqn').value.trim(),cat=$('#eqc').value,desc=$('#eqd').value.trim(),t=Number($('#eqt').value),a=Number($('#eqa').value),o=drum?a:Number($('#eqo').value);
  if(!n)return err('Enter a name for the equipment.');
  if(isNew&&E.some(x=>x.n.toLowerCase()==n.toLowerCase()))return err('That equipment is already in the list.');
  if(!cat)return err('Choose a category.');
  if(!Number.isInteger(t)||t<0)return err('Total stock must be a whole number, 0 or more.');
  if(!isNew&&t<k.u)return err("Total stock can't be lower than the "+k.u+' item(s) in use right now.');
  if(!(a>=0)||!(o>=0))return err('Prices must be 0 or more.');
  if(!ad&&!ou)return err('Pick at least one rent option.');
  if(isNew){const x={n,cat,desc,min:MINRENT,a,o,s:t,ad:ad?1:0,ou:ou?1:0};if(img)x.img=img;E.push(x);STK[n]={t,a:t,u:0};EQN.push(n)}
  else{Object.assign(c,{cat,desc,a,o,ad:ad?1:0,ou:ou?1:0});if(img)c.img=img;else delete c.img;k.t=t;k.a=Math.max(0,t-k.u)}
  dlg.close();syncCat();aeqr();toast(isNew?n+' added.':n+' updated.')};
 dlg.showModal();
}
$('#aeq').addEventListener('click',e=>{
 const ch=e.target.closest('[data-eqc]');
 if(ch){const [i,f]=ch.dataset.eqc.split(':'),c=E[+i];c[f]=c[f]?0:1;syncCat();aeqr();toast(c.n+': '+(f=='ad'?'Add-on':'Outside')+' rentals turned '+(c[f]?'on':'off')+'.');return}
 const ed=e.target.closest('[data-eqe]');if(ed)eqForm(+ed.dataset.eqe)});
$('#eq-add').onclick=()=>eqForm();
$('#eqdlg').addEventListener('click',e=>{if(e.target.id=='eqdlg')$('#eqdlg').close()});
function ovr(){calc();const pn=RN.filter(r=>r[6]=='Pending').length;
 $('#rkpi').innerHTML=ovk('Overdue rentals',OVD.length,'var(--bad)',itm(OVD)+' past return date')+ovk('To return today',DUE.length,'var(--warn)',itm(DUE)+' still to come back')+ovk('Returned today',RTD.length,'var(--ok)',itm(RTD)+' checked in');
 $('#nrent').textContent=pl(sum(RN.filter(r=>r[6]=='In Use').map(r=>r[3])),'item');$('#novd').textContent=OVD.length;$('#npr').textContent=pn;
 const c=$('#rcnt');c.textContent=pn;c.hidden=!pn;
}
const rupd=()=>{rnr();ovr();syncCat();aeqr()};
const ovk=(l,v,c,t)=>`<div class="card kpi"><span class="mut">${l}</span><div class="num" style="color:${c}">${v}</div><span class="mut">${t}</span></div>`,itm=a=>pl(sum(a.map(r=>r[3])),'item');
rupd();

let rp='Month',rt='Booking',hc=null;
function rep(){
 const d=P[rp],inv=rt=='Inventory',s=d.s,rr=d.r.map((c,i)=>c*PR[i]),sr=sum(rr),sv=sum(d.v);
 let k,b,post=()=>{};
 const ch=(x,y)=>`<div class="grid ge" style="margin-top:16px"><div class="card"><h3>${x}</h3><div id="h1"></div></div><div class="card"><h3>${y}</h3><div id="h2"></div></div></div>`;
 const tc=h=>`<div class="card tw" style="margin-top:16px"><h3 style="margin-bottom:8px">${h}</h3><div id="h1"></div></div>`;
 if(rt=='Booking'){k=[['Total bookings',sum(s)],['Confirmed',s[1]],['Pending',s[2]],['Completed',s[0]],['Cancelled',s[3]]];b=ch('Bookings by status','Bookings by studio');post=()=>{hbs('h1',[['Completed',s[0],s[0]],['Confirmed',s[1],s[1]],['Pending',s[2],s[2]],['Cancelled',s[3],s[3]]]);hbs('h2',SN.map((x,i)=>{const n=Math.round(d.v[i]/550);return['Studio '+x,n,n]}))}}
 else if(rt=='Sales'){k=[['Studio revenue',$n(sv)],['Rental revenue',$n(sr)],['Total revenue',$n(sv+sr)]];b=ch('Revenue by studio','Revenue by equipment');post=()=>{hbs('h1',SN.map((x,i)=>['Studio '+x,$n(d.v[i]),d.v[i]]));hbs('h2',N.map((x,i)=>[x,$n(rr[i]),rr[i]]))}}
 else if(rt=='Rental'){k=[['Items rented',sum(d.r)],['Rental income',$n(sr)],['Most rented',sum(d.r)?N[d.r.indexOf(Math.max(...d.r))]:'None']];b=tc('Rental activity');post=()=>tb('h1',['Equipment','Times rented','Price','Income'],N.map((x,i)=>[x,d.r[i],$n(PR[i]),$n(rr[i])]))}
 else if(rt=='Customer'){const c=d.c,cu=cust();if(hc&&!cu.find(x=>x.n==hc))hc=null;k=[['Customers',sum(c)],['New',c[0]],['Returning',c[1]],['Guests',c[2]]];b=tc('Customer spending')+'<div id="h2"></div>';post=()=>{tb('h1',['Customer','Total spent',''],cu.length?cu.map(x=>[x.n,$n(x.t),`<button class="btn sm ${x.n==hc?'':'line'}" data-h="${x.n}">View history</button>`]):[['No spending in this period','','']]);const x=cu.find(y=>y.n==hc);if(x)$('#h2').innerHTML=`<div class="card" style="margin-top:16px"><div class="row"><h3>Spending history: ${x.n}</h3><button class="btn sm line" data-x="1">Close</button></div><p class="mut" style="margin:4px 0 12px">${d.l}</p><h3 style="font-size:14px">Studio rooms booked</h3><div class="tw">${x.s.length?tbl(['Booking','Studio','Date','Hours','Amount'],x.s.map(y=>[y[0],y[1],fd(y[2]),y[3],$n(y[4])]).concat([['<b>Subtotal</b>','','','','<b>'+$n(x.ss)+'</b>']])):'<p class="mut">No studio bookings in this period.</p>'}</div><h3 style="font-size:14px;margin-top:14px">Equipment rented</h3><div class="tw">${x.q.length?tbl(['Equipment','Qty','Date','Amount'],x.q.map(y=>[y[0],y[1],fd(y[2]),$n(y[3])]).concat([['<b>Subtotal</b>','','','<b>'+$n(x.qs)+'</b>']])):'<p class="mut">No equipment rented in this period.</p>'}</div><div class="tot"><span>Total spent</span><span>${$n(x.t)}</span></div></div>`}}
 else if(rt=='Returns'){const rn=d.rn,ov=rp=='Custom'?[]:OVD,tot=rn[0]+rn[1];k=[['Returned on time',rn[0]],['Returned late',rn[1]],['Currently overdue',ov.length],['On-time rate',tot?Math.round(rn[0]/tot*100)+'%':'-']];b=ch('Return status','Overdue days by equipment')+`<div class="card tw" style="margin-top:16px"><h3 style="margin-bottom:8px">Overdue rentals right now</h3><div id="h3"></div></div>`;post=()=>{hbs('h1',[['Returned on time',rn[0],rn[0]],['Returned late',rn[1],rn[1]],['Overdue now',ov.length,ov.length]]);const g={};ov.forEach(r=>g[r[2]]=(g[r[2]]||0)+od(r)*r[3]);const ge=Object.entries(g);hbs('h2',ge.length?ge.map(x=>[x[0],pl(x[1],'day'),x[1]]):[['No overdue equipment','',0]]);tb('h3',['Request','Customer','Equipment','Rental ID','Return date','Overdue'],ov.length?ov.map(r=>[r[0],r[1],r[2],r[4]=='a'?r[5]:OUT(r[5]),r[8],dueB(r)]):[['No overdue rentals in this period','','','','','']])}}
 else{k=[['Items in stock',sum(TOT)],['Available',sum(AV)],['In use',sum(TOT)-sum(AV)],['Low stock',AV.filter(a=>a<2).length]];b=tc('Stock by equipment');post=()=>tb('h1',['Equipment','Total','Available','In use','Status'],N.map((x,i)=>[x,TOT[i],AV[i],TOT[i]-AV[i],AV[i]<2?'Low':'Available']))}
 $('#rp-p').style.opacity=inv?.45:1;
 $('#rp-p').innerHTML='<span class="mut" style="align-self:center;margin-right:4px">Period</span>'+Object.keys(P).map(x=>`<button data-p="${x}" class="${x==rp?'on':''}">${x=='Custom'?'Custom range':x}</button>`).join('');
 $('#rp-t').innerHTML='<span class="mut" style="align-self:center;margin-right:4px">Report</span>'+Object.keys(RT).map(x=>`<button data-r="${x}" class="${x==rt?'on':''}">${x}</button>`).join('');
 $('#rp').innerHTML=`<div class="card" style="margin-bottom:16px"><h2>${rt} report</h2><p class="mut">${inv?'Current stock':'Showing '+d.l}. ${RT[rt]}</p></div>`
 +(rp=='Custom'&&!inv?'<div class="row" style="justify-content:flex-start;margin-bottom:16px"><input type="date" value="2026-09-01" aria-label="From" style="max-width:170px"><input type="date" value="2026-09-30" aria-label="To" style="max-width:170px"><button class="btn sm">Apply</button></div>':'')
 +(FL[rt].length?`<div class="row" style="justify-content:flex-start;flex-wrap:wrap;margin-bottom:16px"><span class="mut">Optional filters</span>${FL[rt].map(sl).join('')}</div>`:'')
 +`<div class="grid g4">${k.map(x=>K(...x)).join('')}</div>`+b
 +'<div class="row" style="margin-top:16px;justify-content:flex-end"><button class="btn line" disabled>Export CSV (coming later)</button></div>';
 post();
}
$('#a-rep').addEventListener('click',e=>{const x=e.target.closest('button');if(!x)return;if(x.dataset.p)rp=x.dataset.p;else if(x.dataset.r){rt=x.dataset.r;hc=null}else if(x.dataset.h!==undefined)hc=x.dataset.h;else if(x.dataset.x!==undefined)hc=null;else return;rep()});
rep();
const pad=n=>String(n).padStart(2,'0'),iso=d=>d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()),toISO=x=>iso(new Date(x+' 2026 12:00'));
const ME=Math.random().toString(36).slice(2),TTL=12e4,LSK='tod_locks';
const lkR=()=>{try{return JSON.parse(localStorage.getItem(LSK)||'{}')}catch(e){return{}}},lkW=o=>{try{localStorage.setItem(LSK,JSON.stringify(o))}catch(e){}};
function lockAcq(keys,who){const L=lkR(),n=Date.now();for(const k in L)if(L[k].x<n||L[k].o==who)delete L[k];if(keys.some(k=>L[k]))return false;keys.forEach(k=>L[k]={o:who,x:n+TTL});lkW(L);return true}
function lockRel(who){const L=lkR();for(const k in L)if(L[k].o==who)delete L[k];lkW(L)}
const lkKeys=(si,d,i,h)=>Array.from({length:h},(_,j)=>S[si][0]+'|'+d+'|'+(i+j));
function occ(si,d){const o=new Set();B.forEach(b=>{if(b[2]=='Studio '+S[si][0]&&b[6]!='Cancelled'&&toISO(b[3])==d){const i=SLOTS.indexOf(b[4]);for(let h=0;h<parseInt(b[5]);h++)o.add(i+h)}});
 const L=lkR(),n=Date.now();for(const k in L){const[a,dd_,i]=k.split('|');if(L[k].x>n&&L[k].o!=ME&&a==S[si][0]&&dd_==d)o.add(+i)}return o}
function addBooking(o){const ref='TOD-'+(Math.max(...B.map(x=>+x[0].slice(4)))+1);
 B.push([ref,o.n,'Studio '+S[o.si][0],fd(o.d),SLOTS[o.t],o.h+(o.h>1?' hrs':' hr'),o.onsite?'Confirmed':'Pending',o.onsite?'Verified':'Pending']);
 META[ref]={own:o.onsite?'staff':'me',method:o.m,ref:o.g||'',amt:S[o.si][2]*o.h};rbk();return ref}
function PAYX(){return B.filter(b=>META[b[0]]).map(b=>{const m=META[b[0]];return[b[0],b[1],fm(m.amt),m.method,m.ref||'Pay at studio',b[7],b[7]=='Pending'?A('Verify','!Reject'):A('!Details')]})}
document.addEventListener('click',e=>{const b=e.target.closest('#abk .btn,#apy .btn,#mybk .btn');if(!b)return;const tr=b.closest('tr'),bk=tr&&B.find(x=>x[0]==tr.children[0].textContent.trim());if(!bk)return;const t=b.textContent;
 if(t=='Cancel'||t=='Reject'){bk[6]='Cancelled';bk[7]='Rejected'}else if(t=='Confirm')bk[6]='Confirmed';else if(t=='Verify'){bk[7]='Verified';if(bk[6]=='Pending')bk[6]='Confirmed'}else return;
 rbk();renderBook();toast(bk[0]+': '+t.replace('Cancel','cancelled').replace('Reject','rejected').replace('Confirm','confirmed').replace('Verify','payment verified')+'.')});
/* ===== Onsite modules (staff / owner) ===== */
const ONS=[],logT=id=>{const e=$('#'+id);e.innerHTML=tbl(['Time','Type','Ref','Customer','Details','Amount','Payment'],ONS.length?ONS:[['No onsite transactions yet','','','','','','']])};
const nowT=()=>new Date().toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}),tEnd=(t,h)=>{const x=10+SLOTS.indexOf(t)+h;return (x%12||12)+':00 '+(x<12?'AM':'PM')};
$('#ob-s').innerHTML=S.map((s,i)=>['Maintenance','Unavailable'].includes(s[3])?'':`<option value="${i}">Studio ${s[0]}, ₱${s[2]}/hr</option>`).join('');$('#ob-d').value=TD;
function onbFree(){const si=+$('#ob-s').value,d=$('#ob-d').value,h=+$('#ob-h').value,o=occ(si,d),f=SLOTS.map((_,i)=>i).filter(i=>i+h<=SLOTS.length&&Array.from({length:h},(_,j)=>!o.has(i+j)).every(Boolean));
 $('#ob-t').innerHTML=f.length?f.map(i=>`<option value="${i}">${SLOTS[i]}</option>`).join(''):'<option value="">No free time</option>';$('#ob-tot').textContent=fm(S[si][2]*h);$('#ob-gw').hidden=$('#ob-m').value!='GCash'}
['ob-s','ob-d','ob-h','ob-m'].forEach(x=>$('#'+x).addEventListener('change',onbFree));
$('#onb').onsubmit=e=>{e.preventDefault();const si=+$('#ob-s').value,d=$('#ob-d').value,h=+$('#ob-h').value,t=$('#ob-t').value,n=$('#ob-n').value.trim(),m=$('#ob-m').value,g=$('#ob-g').value.trim(),er=x=>{$('#ob-e').textContent=x;$('#ob-e').hidden=!x};
 if(!n)return er('Enter the customer name.');if(!d)return er('Pick a date.');if(t==='')return er('No free time for that studio and date.');if(m=='GCash'&&!g)return er('Enter the GCash reference.');
 const oc=occ(si,d);if(Array.from({length:h},(_,j)=>+t+j).some(i=>oc.has(i))||!lockAcq(lkKeys(si,d,+t,h),ME)){onbFree();return er('That time is no longer free.')}
 const ref=addBooking({si,d,t:+t,h,n,m,g,onsite:1});lockRel(ME);er('');
 ONS.unshift([nowT(),'Studio booking',ref,n,'Studio '+S[si][0]+', '+fd(d)+' '+SLOTS[+t]+' ('+h+' hr)',fm(S[si][2]*h),m]);logT('ob-log');logT('or-log');$('#onb').reset();$('#ob-d').value=TD;onbFree();renderBook();toast('Onsite booking '+ref+' recorded.')};
function orForm(){const m=$('#or-m').value;$('#or-eq').innerHTML=E.map((e,i)=>[e,i]).filter(x=>(m=='a'?x[0].ad:x[0].ou)&&x[0].s>0).map(x=>`<option value="${x[1]}">${esc(x[0].n)} (${x[0].s} left, ${fm(m=='a'?x[0].a:x[0].o)})</option>`).join('')||'<option value="">Nothing available</option>';
 ['or-aw'].forEach(x=>$('#'+x).hidden=m!='a');['or-ow','or-rw','or-tw','or-cw'].forEach(x=>$('#'+x).hidden=m!='o');
 $('#or-b').innerHTML=B.filter(b=>['Confirmed','Active'].includes(b[6])).map(b=>`<option>${b[0]}</option>`).join('')||'<option value="">No confirmed bookings</option>';orTot()}
function orTot(){const i=$('#or-eq').value,m=$('#or-m').value;if(i===''){$('#or-tot').textContent=fm(0);return 0}const e=E[i],q=+$('#or-q').value||1,days=m=='o'&&!e.d?Math.max(1,dd($('#or-r').value||TD,TD)):1,t=(m=='a'?e.a:e.o)*q*days;$('#or-tot').textContent=fm(t);return t}
['or-m','or-eq','or-q','or-r'].forEach(x=>$('#'+x).addEventListener('change',()=>x=='or-m'?orForm():orTot()));$('#or-r').value='2026-10-10';
$('#onr').onsubmit=e=>{e.preventDefault();const m=$('#or-m').value,i=$('#or-eq').value,q=+$('#or-q').value,er=x=>{$('#or-e').textContent=x;$('#or-e').hidden=!x};
 if(i==='')return er('Choose equipment.');const eq=E[i],k=STK[eq.n];if(!(q>=1)||q>k.a)return er('Only '+k.a+' of '+eq.n+' available.');
 let id,ret,lab,n;
 if(m=='a'){id=$('#or-b').value;const b=B.find(x=>x[0]==id);if(!b)return er('Choose a confirmed booking.');n=b[1];ret=toISO(b[3]);lab=b[3]+', '+tEnd(b[4],parseInt(b[5]))}
 else{n=$('#or-n').value.trim();ret=$('#or-r').value;if(!n)return er('Enter the customer name.');if(!ret||ret<TD)return er('Choose a valid return date.');if(!$('#or-id').checked)return er('Confirm that you checked a valid ID.');
  id='OUT-'+(Math.max(...RN.filter(r=>r[4]=='o').map(r=>+r[5].slice(4)))+1);lab=fd(ret)}
 const amt=orTot(),rid='R-'+(Math.max(...RN.map(r=>+r[0].slice(2)))+1);
 RN.push([rid,n,eq.n,q,m,id,'In Use',ret,lab,null]);k.a-=q;k.u+=q;er('');
 ONS.unshift([nowT(),m=='a'?'Rental (add-on)':'Rental (outside)',id,n,eq.n+' x'+q+', return '+lab,fm(amt),$('#or-pm').value]);logT('ob-log');logT('or-log');
 rupd();$('#onr').reset();$('#or-r').value='2026-10-10';orForm();toast('Rental '+rid+' issued to '+n+'. Stock updated.')};
logT('ob-log');logT('or-log');onbFree();orForm();renderBook();

/* ---------- page wiring (sidebar tab switching, access guard) ---------- */
window.addEventListener('storage', () => { onbFree(); });
function showTab(id) {
  const tabs = $$('.pg');
  const key = tabs.some(p => p.id === id) ? id : 'a-over';
  tabs.forEach(p => p.classList.toggle('on', p.id === key));
  const mine = $('[data-side="' + key + '"]');
  if (typeof setActiveNav === 'function') setActiveNav(key);
  scrollTo(0, 0);
}
const tabFromHash = () => showTab(location.hash.slice(1));
window.addEventListener('hashchange', tabFromHash);
tabFromHash();
})();
