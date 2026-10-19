#!/usr/bin/env python3
"""Build a public, aggregate-only Candy product-health artifact."""

from __future__ import annotations

import csv
import json
import os
import re
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATASET = (
    Path.home()
    / "Downloads/DA_Game_Teaching_Data/Jelly_Trail_Academy_v2_STUDENT_DELIVERY"
    / "synthetic_jelly_trail_academy_v2"
)
DATASET = Path(os.environ.get("JELLY_DATASET_DIR", DEFAULT_DATASET))
TEMPLATE = ROOT / ".codex/skills/live-artifact/assets/template.html"
OUTPUT = ROOT / "artifacts/candy-product-health-report.html"
SEA = {"VN", "TH", "PH", "ID"}


def rows(name: str):
    with (DATASET / "data" / f"{name}.csv").open(newline="", encoding="utf-8-sig") as handle:
        yield from csv.DictReader(handle)


def number(value: str | None) -> float:
    try:
        return float(value or 0)
    except ValueError:
        return 0.0


def region(country: str) -> str:
    return "SEA" if country in SEA else "Other"


def aggregate_dataset() -> dict:
    manifest = json.loads((DATASET / "manifest.json").read_text(encoding="utf-8"))
    window_end = date.fromisoformat(manifest["data_window"]["end"])
    profiles: dict[str, tuple[str, str, str, str]] = {}
    retention = defaultdict(lambda: {"users_d1": 0, "users_d7": 0, "retained_d1": set(), "retained_d7": set()})
    installs = defaultdict(int)
    user_outcomes = defaultdict(
        lambda: {"revenue_7d": 0.0, "sessions_7d": 0, "retained_d7": 0, "level_attempts": 0, "level_wins": 0,
                 "extra_moves_offered": 0, "extra_moves_purchased": 0}
    )

    for row in rows("users"):
        area = region(row["country"])
        key = (row["install_date"], row["platform"], area, row["app_version_install"])
        profiles[row["user_id"]] = key
        installs[(row["install_date"], row["platform"], area, row["app_version_install"], row["channel"],
                  row["country"], row["campaign_id"])] += 1
        installed = date.fromisoformat(row["install_date"])
        if installed <= window_end - timedelta(days=1):
            retention[key]["users_d1"] += 1
        if installed <= window_end - timedelta(days=7):
            retention[key]["users_d7"] += 1

    assignment_rows = list(rows("ab_assignments"))
    assignment_dates = {row["user_id"]: date.fromisoformat(row["assigned_at"][:10]) for row in assignment_rows}

    daily = defaultdict(
        lambda: {"users": set(), "sessions": 0.0, "playtime": 0.0, "iap_revenue": 0.0,
                 "ad_revenue": 0.0, "crashes": 0.0}
    )
    for row in rows("player_daily"):
        key = (row["activity_date"], row["platform"], region(row["country"]), row["app_version"])
        bucket = daily[key]
        bucket["users"].add(row["user_id"])
        bucket["sessions"] += number(row["sessions"])
        bucket["playtime"] += number(row["playtime_minutes"])
        bucket["iap_revenue"] += number(row["iap_revenue"])
        bucket["ad_revenue"] += number(row["ad_revenue"])
        bucket["crashes"] += number(row["crash_count"])
        profile = profiles.get(row["user_id"])
        if profile and row["cohort_day"] in {"1", "7"}:
            retention[profile][f"retained_d{row['cohort_day']}"].add(row["user_id"])
        assignment_day = assignment_dates.get(row["user_id"])
        days_from_assignment = ((date.fromisoformat(row["activity_date"]) - assignment_day).days
                                if assignment_day else None)
        if days_from_assignment is not None and 0 <= days_from_assignment <= 6:
            outcome = user_outcomes[row["user_id"]]
            outcome["revenue_7d"] += number(row["iap_revenue"]) + number(row["ad_revenue"])
            outcome["sessions_7d"] += round(number(row["sessions"]))
        if days_from_assignment == 7:
            user_outcomes[row["user_id"]]["retained_d7"] = 1

    sessions = defaultdict(lambda: {"sessions": 0, "duration_minutes": 0.0})
    for row in rows("sessions"):
        key = (row["event_date"], row["platform"], region(row["country"]), row["app_version"], row["entry_screen"])
        sessions[key]["sessions"] += 1
        sessions[key]["duration_minutes"] += number(row["duration_minutes"])

    tutorial = defaultdict(lambda: {"eligible": 0, "completed": 0})
    for row in rows("tutorial_steps"):
        key = (row["event_date"], row["platform"], region(row["country"]), row["app_version"],
               row["step_id"], row["step_name"])
        tutorial[key]["eligible"] += 1
        tutorial[key]["completed"] += row["step_completed"] == "1"

    levels = defaultdict(
        lambda: {"attempts": 0, "wins": 0, "fails": 0, "quits": 0, "crashes": 0,
                 "duration_sec": 0.0, "extra_moves_offered": 0, "extra_moves_purchased": 0}
    )
    for row in rows("level_attempts"):
        key = (row["event_date"], row["platform"], region(row["country"]), row["app_version"], row["level_id"])
        levels[key]["attempts"] += 1
        levels[key]["wins"] += row["result"] == "complete"
        levels[key]["fails"] += row["result"] == "fail_out_of_moves"
        levels[key]["quits"] += row["result"] == "quit"
        levels[key]["crashes"] += row["result"] == "crash"
        levels[key]["duration_sec"] += number(row["duration_sec"])
        levels[key]["extra_moves_offered"] += row["extra_moves_offered"] == "1"
        levels[key]["extra_moves_purchased"] += row["extra_moves_purchased"] == "1"
        assignment_day = assignment_dates.get(row["user_id"])
        days_from_assignment = ((date.fromisoformat(row["event_date"]) - assignment_day).days
                                if assignment_day else None)
        if days_from_assignment is not None and 0 <= days_from_assignment <= 6:
            outcome = user_outcomes[row["user_id"]]
            if row["level_id"] in {"28", "29", "30"}:
                outcome["level_attempts"] += 1
                outcome["level_wins"] += row["result"] == "complete"
            outcome["extra_moves_offered"] += row["extra_moves_offered"] == "1"
            outcome["extra_moves_purchased"] += row["extra_moves_purchased"] == "1"

    purchases = defaultdict(lambda: {"purchases": 0, "payers": set(), "gross_revenue": 0.0})
    for row in rows("purchases"):
        key = (row["event_date"], row["platform"], region(row["country"]), row["app_version"], row["product_type"])
        purchases[key]["purchases"] += 1
        purchases[key]["payers"].add(row["user_id"])
        purchases[key]["gross_revenue"] += number(row["price_usd"]) * (-1 if row["is_refund"] == "1" else 1)

    ads = defaultdict(lambda: {"impressions": 0, "viewers": set(), "ad_revenue": 0.0})
    for row in rows("ad_events"):
        key = (row["event_date"], row["platform"], region(row["country"]), row["app_version"],
               row["ad_type"], row["placement"])
        ads[key]["impressions"] += 1
        ads[key]["viewers"].add(row["user_id"])
        ads[key]["ad_revenue"] += number(row["revenue_usd"])

    boosters = defaultdict(int)
    for row in rows("booster_events"):
        key = (row["event_date"], row["platform"], region(row["country"]), row["app_version"], row["booster_type"])
        boosters[key] += 1

    spend = defaultdict(float)
    for row in rows("campaign_spend"):
        spend[(row["date"], row["target_platform"], region(row["country"]), row["channel"],
               row["country"], row["campaign_id"])] += number(row["spend_usd"])

    experiments = defaultdict(
        lambda: {"assigned_users": 0, "assigned_users_d7": 0, "retained_d7": 0, "revenue_7d": 0.0, "sessions_7d": 0,
                 "level_attempts": 0, "level_wins": 0, "extra_moves_offered": 0, "extra_moves_purchased": 0}
    )
    for row in assignment_rows:
        profile = profiles.get(row["user_id"])
        if not profile:
            continue
        _install_day, platform, area, version = profile
        key = (row["assigned_at"][:10], platform, area, version, row["experiment_id"], row["variant"])
        value = experiments[key]
        outcome = user_outcomes[row["user_id"]]
        value["assigned_users"] += 1
        value["assigned_users_d7"] += date.fromisoformat(row["assigned_at"][:10]) <= window_end - timedelta(days=7)
        for field in value:
            if field not in {"assigned_users", "assigned_users_d7"}:
                value[field] += outcome[field]

    public_rows = []
    for (day, platform, area, version), value in daily.items():
        iap_revenue = round(value["iap_revenue"], 2)
        ad_revenue = round(value["ad_revenue"], 2)
        public_rows.append({"kind": "daily", "date": day, "platform": platform, "region": area, "version": version,
                            "active_users": len(value["users"]), "sessions": round(value["sessions"]),
                            "playtime_minutes": round(value["playtime"], 2), "iap_revenue": iap_revenue,
                            "ad_revenue": ad_revenue, "revenue": round(iap_revenue + ad_revenue, 2),
                            "crashes": round(value["crashes"])})
    for (day, platform, area, version, entry), value in sessions.items():
        public_rows.append({"kind": "session", "date": day, "platform": platform, "region": area, "version": version,
                            "entry_screen": entry, "sessions": value["sessions"],
                            "duration_minutes": round(value["duration_minutes"], 2)})
    for (day, platform, area, version, step, step_name), value in tutorial.items():
        public_rows.append({"kind": "tutorial", "date": day, "platform": platform, "region": area, "version": version,
                            "step": step, "step_name": step_name, **value})
    for (day, platform, area, version, level), value in levels.items():
        public_rows.append({"kind": "level", "date": day, "platform": platform, "region": area, "version": version,
                            "level": level, **{field: round(amount, 2) for field, amount in value.items()}})
    for (day, platform, area, version), value in retention.items():
        public_rows.append({"kind": "retention", "date": day, "platform": platform, "region": area, "version": version,
                            "cohort_users_d1": value["users_d1"], "cohort_users_d7": value["users_d7"],
                            "retained_d1": len(value["retained_d1"]), "retained_d7": len(value["retained_d7"])})
    for (day, platform, area, version, product), value in purchases.items():
        public_rows.append({"kind": "purchase", "date": day, "platform": platform, "region": area, "version": version,
                            "product": product.replace("_", " ").title(), "purchases": value["purchases"],
                            "payers": len(value["payers"]), "gross_revenue": round(value["gross_revenue"], 2)})
    for (day, platform, area, version, ad_type, placement), value in ads.items():
        public_rows.append({"kind": "ad", "date": day, "platform": platform, "region": area, "version": version,
                            "ad_type": ad_type.title(), "placement": placement.replace("_", " ").title(),
                            "impressions": value["impressions"], "viewers": len(value["viewers"]),
                            "ad_revenue": round(value["ad_revenue"], 2)})
    for (day, platform, area, version, booster), events in boosters.items():
        public_rows.append({"kind": "booster", "date": day, "platform": platform, "region": area, "version": version,
                            "booster": booster.replace("_", " ").title(), "events": events})

    acquisition = defaultdict(int)
    channel_spend = defaultdict(float)
    for (day, platform, area, version, channel, _country, _campaign), count in installs.items():
        acquisition[(day, platform, area, version, channel)] += count
    for (day, platform, area, channel, _country, _campaign), amount in spend.items():
        channel_spend[(day, platform, area, channel)] += amount
    install_totals = defaultdict(int)
    for (day, platform, area, _version, channel), count in acquisition.items():
        install_totals[(day, platform, area, channel)] += count
    allocated_spend_keys = set()
    for (day, platform, area, version, channel), count in acquisition.items():
        spend_key = (day, platform, area, channel)
        total = install_totals[spend_key]
        allocated_spend_keys.add(spend_key)
        public_rows.append({"kind": "acquisition", "date": day, "platform": platform, "region": area,
                            "version": version, "channel": channel, "installs": count,
                            "spend": round(channel_spend[spend_key] * count / total, 4) if total else 0})
    for (day, platform, area, channel), amount in channel_spend.items():
        if (day, platform, area, channel) not in allocated_spend_keys:
            public_rows.append({"kind": "acquisition", "date": day, "platform": platform, "region": area,
                                "version": "Unattributed", "channel": channel, "installs": 0,
                                "spend": round(amount, 4)})
    for (day, platform, area, version, experiment, variant), value in experiments.items():
        public_rows.append({"kind": "experiment", "date": day, "platform": platform, "region": area,
                            "version": version, "experiment": experiment, "variant": variant,
                            **{field: round(amount, 2) for field, amount in value.items()}})

    public_rows.sort(key=lambda item: (item["date"], item["kind"], item["platform"], item["region"], item["version"],
                                       item.get("level", ""), item.get("step", ""), item.get("channel", "")))
    return {
        "meta": {
            "updatedAt": manifest["data_window"]["end"],
            "generatedAt": manifest["generated_at"],
            "datasetVersion": manifest["dataset_version"],
            "sourceRows": sum(manifest["tables"].values()),
            "publicRows": len(public_rows),
            "demo": True,
            "privacy": "Aggregate-only; no user, session, attempt, ad, or transaction identifiers embedded.",
        },
        "rows": public_rows,
    }


CONFIG = r'''/* CONFIG_START */
  const sumKind=(rows,kind,field)=>sum(rows.filter(row=>row.kind===kind),field);
  const kindRows=(rows,kind,where)=>rows.filter(row=>row.kind===kind&&(!where||where(row)));
  const ratioKind=(rows,kind,num,den,where)=>{const selected=kindRows(rows,kind,where);return ratio(sum(selected,num),sum(selected,den))};
  const dailyAverage=(rows,field)=>{const values=new Map();rows.filter(row=>row.kind==="daily").forEach(row=>values.set(row.date,(values.get(row.date)||0)+Number(row[field]||0)));return values.size?[...values.values()].reduce((a,b)=>a+b,0)/values.size:null};
  const valueLabel=(value,{percent=false,currency=false}={})=>value==null||!Number.isFinite(Number(value))?"—":percent?`${(value*100).toFixed(1)}%`:currency?new Intl.NumberFormat(CONFIG.locale,{style:"currency",currency:CONFIG.currency,maximumFractionDigits:2}).format(value):new Intl.NumberFormat(CONFIG.locale,{maximumFractionDigits:1}).format(value);
  const chartOpts=({percent=false,currency=false,indexAxis="x",stacked=false}={})=>({responsive:true,maintainAspectRatio:false,indexAxis,spanGaps:true,interaction:{mode:"index",intersect:false},plugins:{legend:{position:"top",labels:{boxWidth:11,font:{size:10}}},tooltip:{callbacks:{label:ctx=>`${ctx.dataset.label}: ${valueLabel(indexAxis==="y"?ctx.parsed.x:ctx.parsed.y,{percent,currency})}`}}},scales:{x:{grid:{display:false},stacked,ticks:indexAxis==="y"?{callback:value=>valueLabel(value,{percent,currency})}:{maxRotation:0,autoSkip:true,maxTicksLimit:15}},y:{beginAtZero:true,stacked,ticks:indexAxis==="x"?{callback:value=>valueLabel(value,{percent,currency})}:undefined}}});
  const groupedChart=(rows,{kind,x,series,value,num,den,type="line",percent=false,currency=false,where,scale=1,indexAxis="x",stacked=false,numeric=false})=>{const filtered=kindRows(rows,kind,where),labels=[...new Set(filtered.map(row=>row[x]))].sort((a,b)=>numeric?Number(a)-Number(b):String(a).localeCompare(String(b))),groups=series?[...new Set(filtered.map(row=>row[series]))].sort():["Total"];return{type,data:{labels,datasets:groups.map((group,index)=>({label:String(group),data:labels.map(label=>{const selected=filtered.filter(row=>row[x]===label&&(!series||row[series]===group));if(!selected.length)return null;const result=value?sum(selected,value):ratio(sum(selected,num),sum(selected,den));return result==null?null:result*scale}),borderColor:colors[index%colors.length],backgroundColor:type==="bar"?`${colors[index%colors.length]}bb`:colors[index%colors.length],borderWidth:2,borderDash:type==="bar"?[]:[[],[7,4],[2,3]][index%3],pointStyle:["circle","rectRot","triangle"][index%3],pointRadius:type==="line"?2:0,tension:.3,spanGaps:true,borderRadius:3,fill:false}))},options:chartOpts({percent,currency,indexAxis,stacked})}};
  const measureChart=(rows,{kind,x,measures,type="line",percent=false,currency=false,stacked=false,where,numeric=false})=>{const filtered=kindRows(rows,kind,where),labels=[...new Set(filtered.map(row=>row[x]))].sort((a,b)=>numeric?Number(a)-Number(b):String(a).localeCompare(String(b)));return{type,data:{labels,datasets:measures.map((measure,index)=>({label:measure.label,data:labels.map(label=>{const selected=filtered.filter(row=>row[x]===label);return selected.length?(measure.ratio?ratio(sum(selected,measure.field),sum(selected,measure.den)):sum(selected,measure.field)):null}),borderColor:measure.color||colors[index%colors.length],backgroundColor:`${measure.color||colors[index%colors.length]}bb`,borderWidth:2,borderDash:type==="bar"?[]:[[],[7,4],[2,3]][index%3],pointStyle:["circle","rectRot","triangle"][index%3],pointRadius:type==="line"?2:0,tension:.3,fill:stacked}))},options:chartOpts({percent,currency,stacked})}};
  const failureChart=rows=>measureChart(rows,{kind:"level",x:"level",type:"bar",percent:true,stacked:true,numeric:true,where:row=>["28","29","30"].includes(row.level),measures:[{label:"Complete",field:"wins",den:"attempts",ratio:true,color:"#15803d"},{label:"Out of moves",field:"fails",den:"attempts",ratio:true,color:"#d97706"},{label:"Quit",field:"quits",den:"attempts",ratio:true,color:"#7c3aed"},{label:"Crash",field:"crashes",den:"attempts",ratio:true,color:"#dc2626"}]});
  const retentionChart=rows=>{const filtered=rows.filter(row=>row.kind==="retention"),labels=[...new Set(filtered.map(row=>row.version))].sort(),make=(label,num,den,color)=>({label,data:labels.map(version=>{const selected=filtered.filter(row=>row.version===version);return ratio(sum(selected,num),sum(selected,den))}),backgroundColor:color,borderColor:color,borderRadius:3});return{type:"bar",data:{labels,datasets:[make("D1 retention","retained_d1","cohort_users_d1",colors[0]),make("D7 retention","retained_d7","cohort_users_d7",colors[1])]},options:chartOpts({percent:true})}};
  const signedChange=value=>value==null?"not observable":`${value>=0?"+":""}${value.toFixed(1)}%`;
  const signedPoints=value=>value==null?"not observable":`${value>=0?"+":""}${value.toFixed(1)} pp`;
  const evidenceCoverage=count=>count>=1000?"High":count>=200?"Medium":"Limited";
  const scopeLabel=state=>`${state.range.start} to ${state.range.end} · ${(state.values.platform||[]).join(", ")||"all platforms"} · ${(state.values.region||[]).join(", ")||"all regions"} · ${(state.values.version||[]).join(", ")||"all versions"}`;
  const aggregateBy=(rows,kind,key,fields,where)=>{const groups=new Map();kindRows(rows,kind,where).forEach(row=>{const id=row[key],value=groups.get(id)||Object.fromEntries(fields.map(field=>[field,0]));fields.forEach(field=>value[field]+=Number(row[field]||0));groups.set(id,value)});return groups};
  const CONFIG={
    name:"candy-product-intelligence",title:"Candy Product Intelligence Dashboard",subtitle:"Acquisition → activation → engagement → progression → monetization → retention · 60-day synthetic teaching dataset",eyebrow:"Codex data analysis artifact",locale:"en-US",currency:"USD",dateField:"date",dataMode:"inline",demo:true,
    source:{label:"Candy synthetic teaching dataset · aggregate analytical mart",url:"",method:"GET",expectedFields:["kind","date","platform","region","version"],notes:"Built by Codex from 10 source tables in the project’s synthetic teaching dataset. The public payload contains aggregate rows only; no user, session, attempt, advertising, or transaction identifiers are embedded. Observational comparisons describe this demo dataset and do not establish causality."},
    defaultView:"flow",
    views:[
      {id:"flow",label:"Learning flow",kind:"flow",title:"Learning flow",note:"Observe → Segment → Diagnose → Validate → Recommend, organized along the player lifecycle."},
      {id:"guided",label:"Guided insights",kind:"guided",title:"Guided insights",note:"Evidence-led decision briefs generated by Codex’s analysis framework and recalculated for the active filters."},
      {id:"strategic",label:"Strategic",kind:"taxonomy",taxonomy:"strategic",title:"Strategic dashboard",note:"Long-horizon product health for leadership: audience scale, revenue and retention."},
      {id:"operational",label:"Operational",kind:"taxonomy",taxonomy:"operational",title:"Operational dashboard",note:"Day-to-day monitoring for stability, sessions, engagement depth and feature usage."},
      {id:"analytical",label:"Analytical",kind:"taxonomy",taxonomy:"analytical",title:"Analytical dashboard",note:"Diagnostic views that explain activation and progression changes."},
      {id:"tactical",label:"Tactical",kind:"taxonomy",taxonomy:"tactical",title:"Tactical dashboard",note:"Team-level decisions for acquisition, monetization and experiments."}
    ],
    filters:[{id:"range",type:"daterange",label:"Date range",defaultDays:30},{id:"platform",type:"multiselect",label:"Platform",field:"platform",options:"auto",default:["Android"]},{id:"region",type:"multiselect",label:"Region",field:"region",options:"auto",default:["SEA"]},{id:"version",type:"multiselect",label:"App version",field:"version",options:"auto"}],
    guidedMeta:{title:"Codex-guided decision narrative",author:"Build-time Codex framework",note:"Each brief follows What changed → Where → Why it might have changed → Evidence → Action → Uncertainty. Numeric statements recompute locally from filtered aggregate data; no model or API is called in the browser."},
    metrics:[
      {id:"avg-dau",taxonomy:"strategic",label:"Average DAU",agg:"calc",calculate:rows=>dailyAverage(rows,"active_users"),formula:"AVG(daily SUM(active_users))",format:"integer",icon:"orders",note:"Average daily active users across the selected segment."},
      {id:"installs",taxonomy:"tactical",label:"New installs",agg:"calc",calculate:rows=>sumKind(rows,"acquisition","installs"),formula:"SUM(acquisition installs)",format:"compact",icon:"trend",note:"New users attributed to acquisition channels."},
      {id:"spend",taxonomy:"tactical",label:"Paid spend",agg:"calc",calculate:rows=>sumKind(rows,"acquisition","spend"),formula:"SUM(campaign spend)",format:"currency",icon:"currency",note:"Allocated campaign spend for selected installs."},
      {id:"cpi",taxonomy:"tactical",label:"Paid cost per install",agg:"calc",calculate:rows=>ratioKind(rows,"acquisition","spend","installs",row=>row.channel!=="Organic"),formula:"SUM(paid-channel spend) / SUM(paid-channel installs)",format:"currency",icon:"calculator",improvement:"down",note:"Blended acquisition efficiency across channels with paid spend; Organic is excluded."},
      {id:"tutorial",taxonomy:"analytical",label:"Tutorial step 4 completion",agg:"calc",calculate:rows=>ratioKind(rows,"tutorial","completed","eligible",row=>row.step==="4"),formula:"SUM(step 4 completed) / SUM(step 4 eligible)",format:"percent",icon:"trend",note:"Activation checkpoint most affected by the v2.1.0 regression."},
      {id:"sessions",taxonomy:"operational",label:"Sessions",agg:"calc",calculate:rows=>sumKind(rows,"daily","sessions"),formula:"SUM(daily sessions)",format:"compact",icon:"bars",note:"Total sessions in the selected period."},
      {id:"playtime",taxonomy:"operational",label:"Playtime per active user",agg:"calc",calculate:rows=>ratio(sumKind(rows,"daily","playtime_minutes"),sumKind(rows,"daily","active_users")),formula:"SUM(playtime_minutes) / SUM(active_users)",format:"decimal",icon:"calculator",note:"Minutes per active user-day."},
      {id:"win-rate",taxonomy:"analytical",label:"Levels 28–30 win rate",agg:"calc",calculate:rows=>ratioKind(rows,"level","wins","attempts",row=>["28","29","30"].includes(row.level)),formula:"SUM(level 28–30 wins) / SUM(attempts)",format:"percent",icon:"trend",note:"Completion rate for the diagnosed friction band."},
      {id:"revenue",taxonomy:"strategic",label:"Revenue",agg:"calc",calculate:rows=>sumKind(rows,"daily","revenue"),formula:"SUM(iap_revenue + ad_revenue)",format:"currency",icon:"currency",note:"Combined IAP and advertising revenue."},
      {id:"arpdau",taxonomy:"strategic",label:"ARPDAU",agg:"calc",calculate:rows=>ratio(sumKind(rows,"daily","revenue"),sumKind(rows,"daily","active_users")),formula:"SUM(revenue) / SUM(active_users)",format:"currency",icon:"calculator",note:"Revenue per active user-day."},
      {id:"retention-d7",taxonomy:"strategic",label:"D7 retention",agg:"calc",calculate:rows=>ratioKind(rows,"retention","retained_d7","cohort_users_d7"),formula:"SUM(retained_d7) / SUM(mature cohort users)",format:"percent",icon:"trend",note:"Only cohorts mature enough to observe day 7 are included."},
      {id:"crash-rate",taxonomy:"operational",label:"Crashes / 1K sessions",agg:"calc",calculate:rows=>ratio(sumKind(rows,"daily","crashes")*1000,sumKind(rows,"daily","sessions")),formula:"SUM(crashes) × 1000 / SUM(sessions)",format:"decimal",icon:"trend",improvement:"down",note:"Session-normalized stability indicator."}
    ],
    guidedInsights:[
      {id:"executive-pulse",domain:"Executive pulse",calculate:({rows,previousRows,state})=>{const current={dau:dailyAverage(rows,"active_users"),revenue:sumKind(rows,"daily","revenue"),retention:ratioKind(rows,"retention","retained_d7","cohort_users_d7"),crashes:ratio(sumKind(rows,"daily","crashes")*1000,sumKind(rows,"daily","sessions"))},prior={dau:dailyAverage(previousRows,"active_users"),revenue:sumKind(previousRows,"daily","revenue"),retention:ratioKind(previousRows,"retention","retained_d7","cohort_users_d7"),crashes:ratio(sumKind(previousRows,"daily","crashes")*1000,sumKind(previousRows,"daily","sessions"))},signals=[{label:"Average DAU",key:"dau",format:"integer"},{label:"Revenue",key:"revenue",format:"currency"},{label:"D7 retention",key:"retention",format:"percent"},{label:"Crash rate",key:"crashes",format:"decimal",down:true,contextOnly:true}].map(signal=>({...signal,change:delta(current[signal.key],prior[signal.key]),comparable:signal.key==="retention"?prior[signal.key]>=.01:prior[signal.key]>=current[signal.key]*.1})),leader=signals.filter(signal=>!signal.contextOnly&&signal.change!=null&&signal.comparable).sort((a,b)=>Math.abs(b.change)-Math.abs(a.change))[0],favorable=leader&&(leader.down?leader.change<0:leader.change>0);return{headline:leader?`${leader.label} moved ${signedChange(leader.change)} period over period`:"Prior-period movement is not comparable",tone:leader?(favorable?"recovery":"risk"):"watch",changed:leader?`${leader.label} is the largest comparable relative movement among audience, revenue and retention in this selection.`:"The prior equal-length window has insufficient coverage for a reliable relative comparison.",where:scopeLabel(state),hypothesis:"The movement may reflect release mix, audience volume or calendar effects. The aggregate snapshot identifies the signal but cannot isolate a causal driver.",evidence:signals.map(signal=>`${signal.label}: ${format(current[signal.key],signal.format)} now vs ${format(prior[signal.key],signal.format)} prior${signal.contextOnly?" (context metric)":signal.comparable?` (${signedChange(signal.change)})`:" (prior coverage too low for relative ranking)"}`),action:leader?`Segment ${leader.label} by app version and platform, then inspect the corresponding lifecycle chart before changing product or spend decisions.`:"Widen the selected date range or include established versions to restore a comparable baseline.",uncertainty:"Period-over-period comparisons are descriptive and are not seasonality-adjusted. Near-zero baselines and crash rate are excluded from relative ranking because they can exaggerate percentage change.",coverage:leader?"High":"Limited"}}},
      {id:"activation-diagnosis",domain:"Activation",calculate:({rows,state})=>{const release=version=>{const selected=kindRows(rows,"tutorial",row=>row.step==="4"&&row.version===version);return{eligible:sum(selected,"eligible"),completed:sum(selected,"completed"),rate:ratio(sum(selected,"completed"),sum(selected,"eligible"))}},affected=release("2.1.0"),hotfix=release("2.1.1"),gap=affected.rate!=null&&hotfix.rate!=null?(hotfix.rate-affected.rate)*100:null,total=affected.eligible+hotfix.eligible;return{headline:gap!=null?`Hotfix step 4 completion is ${Math.abs(gap).toFixed(1)} pp ${gap>=0?"above":"below"} v2.1.0`:"Release recovery cannot be compared in this selection",tone:gap==null?"watch":gap>0?"recovery":"risk",changed:gap!=null?`Step 4 completion moved from ${valueLabel(affected.rate,{percent:true})} on v2.1.0 to ${valueLabel(hotfix.rate,{percent:true})} on v2.1.1.`:"One or both release versions are excluded or absent.",where:`Tutorial step 4 · ${scopeLabel(state)}`,hypothesis:"A release-specific activation defect is plausible because the adjacent hotfix recovers on the same funnel checkpoint. This pattern is consistent with—but does not prove—a product fix.",evidence:[`v2.1.0: ${affected.completed.toLocaleString()} completions / ${affected.eligible.toLocaleString()} eligible (${valueLabel(affected.rate,{percent:true})})`,`v2.1.1: ${hotfix.completed.toLocaleString()} completions / ${hotfix.eligible.toLocaleString()} eligible (${valueLabel(hotfix.rate,{percent:true})})`,`Observed release gap: ${signedPoints(gap)}`],action:"Review the v2.1.0 step 4 implementation and event instrumentation, then confirm recovery by platform before closing the incident.",uncertainty:"Versions were not randomly assigned. Rollout timing, acquisition mix and returning-player composition may differ between releases.",coverage:evidenceCoverage(total)}}},
      {id:"progression-hotspot",domain:"Progression",calculate:({rows,state})=>{const affected=aggregateBy(rows,"level","level",["wins","attempts"],row=>row.version==="2.1.0"&&["28","29","30"].includes(row.level)),ranked=[...affected].filter(([,value])=>value.attempts>0).sort((a,b)=>a[1].wins/a[1].attempts-b[1].wins/b[1].attempts),worst=ranked[0],hotfix=worst?aggregateBy(rows,"level","level",["wins","attempts"],row=>row.version==="2.1.1"&&row.level===worst[0]).get(worst[0]):null,affectedRate=worst?ratio(worst[1].wins,worst[1].attempts):null,hotfixRate=hotfix?ratio(hotfix.wins,hotfix.attempts):null,gap=affectedRate!=null&&hotfixRate!=null?(hotfixRate-affectedRate)*100:null,count=(worst?.[1].attempts||0)+(hotfix?.attempts||0);return{headline:worst?`Level ${worst[0]} is the v2.1.0 friction hotspot at ${valueLabel(affectedRate,{percent:true})} win rate`:"The diagnosed level band is absent from this selection",tone:worst?"risk":"watch",changed:worst?`Among levels 28–30, level ${worst[0]} has the lowest v2.1.0 completion rate.`:"No v2.1.0 attempts are available for levels 28–30.",where:`Levels 28–30 · ${scopeLabel(state)}`,hypothesis:"An abrupt release-specific drop can indicate tuning, board generation or stability friction. Failure composition should be checked before choosing a remedy.",evidence:worst?[`v2.1.0 level ${worst[0]}: ${worst[1].wins.toLocaleString()} wins / ${worst[1].attempts.toLocaleString()} attempts`,hotfix?`v2.1.1 same level: ${hotfix.wins.toLocaleString()} wins / ${hotfix.attempts.toLocaleString()} attempts (${signedPoints(gap)} vs v2.1.0)`:"No matching v2.1.1 comparison in the selected filters"]:["No eligible level attempts in the selected filters"],action:worst?`Inspect out-of-moves, quits and crashes at level ${worst[0]}; reproduce the board on v2.1.0 before altering difficulty.`:"Include v2.1.0 and widen the date range to inspect the known friction band.",uncertainty:"Win rate alone cannot distinguish intentional difficulty from defects, and repeated attempts from the same player are aggregated.",coverage:evidenceCoverage(count)}}},
      {id:"acquisition-efficiency",domain:"Acquisition",calculate:({rows,previousRows,state})=>{const paid=row=>row.channel!=="Organic",channels=aggregateBy(rows,"acquisition","channel",["installs","spend"],paid),ranked=[...channels].map(([channel,value])=>({channel,...value,cpi:ratio(value.spend,value.installs)})).filter(item=>item.installs>0&&item.spend>0),efficient=[...ranked].sort((a,b)=>a.cpi-b.cpi)[0],volume=[...ranked].sort((a,b)=>b.installs-a.installs)[0],currentCpi=ratioKind(rows,"acquisition","spend","installs",paid),priorCpi=ratioKind(previousRows,"acquisition","spend","installs",paid),movement=delta(currentCpi,priorCpi),installs=ranked.reduce((total,item)=>total+item.installs,0);return{headline:efficient?`${efficient.channel} has the lowest paid CPI at ${valueLabel(efficient.cpi,{currency:true})}`:"Paid acquisition efficiency is not observable",tone:movement==null?"watch":movement<=0?"recovery":"risk",changed:movement==null?"The prior-period paid CPI comparison is unavailable.":`Blended paid CPI changed ${signedChange(movement)} versus the previous equal-length period.`,where:`Paid acquisition channels · ${scopeLabel(state)}`,hypothesis:"Channel mix can explain blended CPI movement; a greater share from a lower-cost channel can improve the aggregate without a within-channel efficiency gain.",evidence:efficient?[`Lowest paid CPI: ${efficient.channel} · ${valueLabel(efficient.cpi,{currency:true})} from ${efficient.installs.toLocaleString()} installs`,`Largest paid install volume: ${volume.channel} · ${volume.installs.toLocaleString()} installs`,`Blended paid CPI: ${valueLabel(currentCpi,{currency:true})} now vs ${valueLabel(priorCpi,{currency:true})} prior`]:["No paid-channel installs in the selected filters"],action:"Compare channel-level CPI and downstream D7 quality before reallocating spend; preserve a holdout or controlled incrementality test.",uncertainty:"Attributed installs and allocated spend do not measure incrementality. Organic is excluded from CPI; the public aggregate payload has no campaign-quality outcome join.",coverage:evidenceCoverage(installs)}}},
      {id:"experiment-readout",domain:"Experiment",calculate:({rows,state})=>{const variants=aggregateBy(rows,"experiment","variant",["assigned_users_d7","retained_d7","extra_moves_offered","extra_moves_purchased"]),control=variants.get("control_after_3_fails"),treatment=variants.get("early_offer_after_1_fail"),retention=value=>value?ratio(value.retained_d7,value.assigned_users_d7):null,conversion=value=>value?ratio(value.extra_moves_purchased,value.extra_moves_offered):null,controlRetention=retention(control),treatmentRetention=retention(treatment),controlConversion=conversion(control),treatmentConversion=conversion(treatment),retentionGap=controlRetention!=null&&treatmentRetention!=null?(treatmentRetention-controlRetention)*100:null,conversionGap=controlConversion!=null&&treatmentConversion!=null?(treatmentConversion-controlConversion)*100:null,count=(control?.assigned_users_d7||0)+(treatment?.assigned_users_d7||0);return{headline:retentionGap!=null?`Early offer changes D7 retention by ${signedPoints(retentionGap)}`:"Mature experiment readout is unavailable",tone:retentionGap==null?"watch":retentionGap>=0?"recovery":"risk",changed:retentionGap!=null?`The early-offer variant is ${Math.abs(retentionGap).toFixed(1)} pp ${retentionGap>=0?"above":"below"} control on mature-cohort D7 retention.`:"One or both variants lack mature D7 assignments in this selection.",where:`Extra-moves offer-timing experiment · ${scopeLabel(state)}`,hypothesis:"Earlier exposure may change both purchase conversion and player frustration, so retention and conversion should be interpreted together.",evidence:[`D7 retention — control: ${valueLabel(controlRetention,{percent:true})}; early offer: ${valueLabel(treatmentRetention,{percent:true})}; gap ${signedPoints(retentionGap)}`,`Extra-moves conversion — control: ${valueLabel(controlConversion,{percent:true})}; early offer: ${valueLabel(treatmentConversion,{percent:true})}; gap ${signedPoints(conversionGap)}`,`Mature D7 assignments: ${count.toLocaleString()}`],action:"Run a statistical significance and sample-ratio check, then review revenue and gameplay guardrails before making a rollout decision.",uncertainty:"The dashboard reports descriptive aggregate lifts only; it does not calculate confidence intervals, p-values, multiple-testing corrections or sample-ratio mismatch.",coverage:evidenceCoverage(count)}}}
    ],
    insights:[
      {taxonomy:"analytical",label:"v2.1.0 activation signal",calculate:rows=>{const release=ratioKind(rows,"tutorial","completed","eligible",row=>row.step==="4"&&row.version==="2.1.0");return release!=null?{value:valueLabel(release,{percent:true}),note:"Step 4 completion; below 75% is flagged for review",tone:release<.75?"risk":"recovery"}:{value:"—",note:"Select v2.1.0 to inspect the release",tone:"watch"}}},
      {taxonomy:"analytical",label:"Hotfix recovery",calculate:rows=>{const before=ratioKind(rows,"tutorial","completed","eligible",row=>row.step==="4"&&row.version==="2.1.0"),after=ratioKind(rows,"tutorial","completed","eligible",row=>row.step==="4"&&row.version==="2.1.1");return before!=null&&after!=null?{value:`${((after-before)*100).toFixed(1)} pp`,note:"v2.1.1 step 4 completion versus v2.1.0",tone:after>before?"recovery":"risk"}:{value:"—",note:"Select v2.1.0 and v2.1.1 to compare",tone:"watch"}}},
      {taxonomy:"analytical",label:"v2.1.0 progression hotspot",calculate:rows=>{const selected=kindRows(rows,"level",row=>row.version==="2.1.0"&&["28","29","30"].includes(row.level)),byLevel=new Map();selected.forEach(row=>{const value=byLevel.get(row.level)||{wins:0,attempts:0};value.wins+=row.wins;value.attempts+=row.attempts;byLevel.set(row.level,value)});const ranked=[...byLevel].filter(([,value])=>value.attempts>=30).sort((a,b)=>a[1].wins/a[1].attempts-b[1].wins/b[1].attempts),worst=ranked[0];return worst?{value:`Level ${worst[0]} · ${(worst[1].wins/worst[1].attempts*100).toFixed(1)}%`,note:`Lowest release win rate with ${worst[1].attempts.toLocaleString()} attempts`,tone:"watch"}:{value:"—",note:"Select v2.1.0 or widen the date range",tone:"watch"}}},
      {taxonomy:"strategic",label:"Revenue mix",calculate:rows=>{const ad=sumKind(rows,"daily","ad_revenue"),total=sumKind(rows,"daily","revenue"),share=ratio(ad,total);return share!=null?{value:`${(share*100).toFixed(1)}% ads`,note:`${valueLabel(1-share,{percent:true})} from in-app purchases`,tone:""}:{value:"—",note:"No revenue in this segment",tone:"watch"}}}
    ],
    sections:[
      {id:"executive",title:"Executive health",note:"Scale, engagement, revenue and stability over the selected period."},
      {id:"acquisition",title:"Acquisition efficiency",note:"Install volume, spend allocation and blended cost per install by channel."},
      {id:"activation",title:"Activation funnel",note:"Tutorial completion across all five steps and the diagnosed step 4 breakpoint."},
      {id:"engagement",title:"Engagement",note:"Session entry behavior, playtime depth and booster usage."},
      {id:"progression",title:"Progression & level health",note:"Difficulty curve across 60 levels plus failure composition in levels 28–30."},
      {id:"monetization",title:"Monetization",note:"IAP/ad composition, product performance and advertising yield."},
      {id:"retention",title:"Retention",note:"Maturity-safe D1 and D7 cohort performance by install version."},
      {id:"experiment",title:"Experiment readout",note:"Directional outcomes for the extra-moves offer-timing assignment."}
    ],
    charts:[
      {id:"dau-trend",section:"executive",taxonomy:"strategic",title:"Daily active users by version",icon:"trend",fullWidth:true,note:"Daily active users split by app version.",build:({rows})=>groupedChart(rows,{kind:"daily",x:"date",series:"version",value:"active_users"})},
      {id:"revenue-trend",section:"executive",taxonomy:"strategic",title:"Revenue trend",icon:"currency",note:"IAP plus ad revenue by day.",build:({rows})=>groupedChart(rows,{kind:"daily",x:"date",value:"revenue",currency:true})},
      {id:"crash-trend",section:"executive",taxonomy:"operational",title:"Crashes per 1K sessions by version",icon:"trend",formula:"SUM(crashes) × 1000 / SUM(sessions)",note:"Session-normalized release stability.",build:({rows})=>groupedChart(rows,{kind:"daily",x:"date",series:"version",num:"crashes",den:"sessions",scale:1000})},
      {id:"installs-channel",section:"acquisition",taxonomy:"tactical",title:"Installs by channel",icon:"bars",note:"Attributed installs for the selected segment.",build:({rows})=>groupedChart(rows,{kind:"acquisition",x:"channel",value:"installs",type:"bar"})},
      {id:"cpi-channel",section:"acquisition",taxonomy:"tactical",title:"Paid cost per install by channel",icon:"currency",formula:"SUM(spend) / SUM(installs) for paid channels",note:"Spend-weighted CPI; Organic is excluded because it has no paid spend.",build:({rows})=>groupedChart(rows,{kind:"acquisition",x:"channel",num:"spend",den:"installs",type:"bar",currency:true,where:row=>row.channel!=="Organic"})},
      {id:"session-entry",section:"engagement",taxonomy:"operational",title:"Session entry mix",icon:"bars",note:"Where sessions begin in the selected segment.",build:({rows})=>groupedChart(rows,{kind:"session",x:"entry_screen",value:"sessions",type:"bar"})},
      {id:"playtime-trend",section:"engagement",taxonomy:"operational",title:"Playtime per active user by version",icon:"trend",formula:"SUM(playtime) / SUM(active users)",note:"Daily engagement depth by release.",build:({rows})=>groupedChart(rows,{kind:"daily",x:"date",series:"version",num:"playtime_minutes",den:"active_users"})},
      {id:"booster-mix",section:"engagement",taxonomy:"operational",title:"Booster usage mix",icon:"bars",note:"Usage events by booster type.",build:({rows})=>groupedChart(rows,{kind:"booster",x:"booster",value:"events",type:"bar"})},
      {id:"tutorial-funnel",section:"activation",taxonomy:"analytical",title:"Tutorial completion rate by step and version",icon:"trend",fullWidth:true,formula:"SUM(completed) / SUM(eligible)",note:"Step-level completion among users who reached each tutorial event.",build:({rows})=>groupedChart(rows,{kind:"tutorial",x:"step",series:"version",num:"completed",den:"eligible",percent:true,numeric:true})},
      {id:"tutorial-version",section:"activation",taxonomy:"analytical",title:"Step 4 completion by version",icon:"bars",formula:"SUM(step 4 completed) / SUM(step 4 eligible)",note:"v2.1.0 shows a material activation drop; v2.1.1 recovers near baseline.",build:({rows})=>groupedChart(rows,{kind:"tutorial",x:"version",num:"completed",den:"eligible",type:"bar",percent:true,where:row=>row.step==="4"})},
      {id:"level-curve",section:"progression",taxonomy:"analytical",title:"Win-rate curve across 60 levels",icon:"trend",fullWidth:true,formula:"SUM(wins) / SUM(attempts)",note:"Release-level difficulty curve; compare discontinuities around levels 28–30.",build:({rows})=>groupedChart(rows,{kind:"level",x:"level",series:"version",num:"wins",den:"attempts",percent:true,numeric:true})},
      {id:"failure-mode",section:"progression",taxonomy:"analytical",title:"Failure composition · levels 28–30",icon:"bars",formula:"Outcome count / attempts",note:"100% stacked outcome mix isolates out-of-moves, quit and crash pressure.",build:({rows})=>failureChart(rows)},
      {id:"revenue-mix",section:"monetization",taxonomy:"strategic",title:"IAP vs ad revenue over time",icon:"currency",fullWidth:true,note:"Daily revenue composition by source.",build:({rows})=>measureChart(rows,{kind:"daily",x:"date",type:"line",currency:true,stacked:true,measures:[{label:"IAP",field:"iap_revenue"},{label:"Ads",field:"ad_revenue"}]})},
      {id:"product-revenue",section:"monetization",taxonomy:"tactical",title:"IAP revenue by product",icon:"currency",note:"Gross revenue by product family.",build:({rows})=>groupedChart(rows,{kind:"purchase",x:"product",value:"gross_revenue",type:"bar",currency:true})},
      {id:"ad-yield",section:"monetization",taxonomy:"tactical",title:"Ad eCPM by placement",icon:"bars",formula:"SUM(ad revenue) × 1000 / SUM(impressions)",note:"Advertising yield normalized per thousand impressions.",build:({rows})=>groupedChart(rows,{kind:"ad",x:"placement",num:"ad_revenue",den:"impressions",type:"bar",currency:true,scale:1000})},
      {id:"retention",section:"retention",taxonomy:"strategic",title:"Mature-cohort retention by install version",icon:"bars",fullWidth:true,note:"D1 and D7 retention use separate maturity-eligible denominators.",build:({rows})=>retentionChart(rows)},
      {id:"experiment-retention",section:"experiment",taxonomy:"tactical",title:"A/B test · D7 retention by variant",icon:"bars",formula:"SUM(retained D7) / SUM(mature assigned users)",note:"Only assignments mature enough to observe day 7 enter the denominator.",build:({rows})=>groupedChart(rows,{kind:"experiment",x:"variant",num:"retained_d7",den:"assigned_users_d7",type:"bar",percent:true})},
      {id:"experiment-conversion",section:"experiment",taxonomy:"tactical",title:"A/B test · extra-moves conversion",icon:"trend",formula:"SUM(extra moves purchased) / SUM(offers)",note:"Offer-to-purchase conversion by assigned variant.",build:({rows})=>groupedChart(rows,{kind:"experiment",x:"variant",num:"extra_moves_purchased",den:"extra_moves_offered",type:"bar",percent:true})}
    ]
  };
  /* CONFIG_END */'''


def build() -> Path:
    payload = aggregate_dataset()
    html = TEMPLATE.read_text(encoding="utf-8")
    html = re.sub(r"<title>.*?</title>", "<title>Candy Product Intelligence Dashboard</title>", html, count=1)
    html = re.sub(r"  /\* CONFIG_START \*/[\s\S]*?  /\* CONFIG_END \*/", CONFIG, html, count=1)
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).replace("</script>", "<\\/script>")
    html = re.sub(
        r'(<script id="artifact-data" type="application/json">)[\s\S]*?(</script>)',
        lambda match: f"{match.group(1)}\n  {encoded}\n  {match.group(2)}",
        html,
        count=1,
    )
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(html, encoding="utf-8")
    print(json.dumps({"ok": True, "output": str(OUTPUT), "publicRows": payload["meta"]["publicRows"]}))
    return OUTPUT


if __name__ == "__main__":
    build()
