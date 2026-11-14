import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createHmac } from "node:crypto";

async function login(page: Page) {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill("fixture@campusmate.test");
  await page.locator('input[type="password"]').fill("fixture-only-password");
  const response=page.waitForResponse(r=>r.url().includes("/auth/v1/token"));
  await page.getByRole("button", {name:"登录",exact:true}).click();
  await expect(page).toHaveURL(/\/app$/);
  return (await (await response).json()).access_token as string;
}
async function send(page: Page, text: string) {
  await page.getByPlaceholder(/输入消息/).fill(text);
  const response = page.waitForResponse(r => r.url().endsWith("/v1/tasks") && r.request().method() === "POST");
  await page.getByRole("button", {name:"发送",exact:true}).click();
  return (await (await response).json()).taskId as string;
}
test("身份→推荐→策划书：真实任务、工具进度、刷新、预览和三格式字节下载", async ({page,request}, info) => {
  const token=await login(page); await page.goto("/app/agent");
  await page.getByLabel("思考强度").selectOption("high");
  await send(page, "我是计算机专业大二学生，擅长Python，每周可投入8小时。");
  await expect(page.getByText("已记录你的计算机专业大二身份和每周8小时约束。", {exact:true})).toBeVisible();
  await send(page, "根据我的情况推荐一个竞赛");
  await expect(page.getByText(/基于你已提供的计算机专业大二/)).toBeVisible();
  const taskId=await send(page, "请写一份校园信息助手竞赛项目策划书，至少1000字，包含资料、提纲、正文与引用。");
  await expect(page.getByRole("list",{name:"工具执行记录"})).toContainText("核对网页来源");
  await page.reload();
  await expect(page.getByRole("button", {name:/查看文档.*预览与下载/}).first()).toBeVisible({timeout:60_000});
  await page.getByRole("button", {name:/查看文档.*预览与下载/}).first().click();
  await expect(page.getByRole("article", {name:"文档正文"})).toContainText("背景与问题");
  await expect(page.getByRole("article", {name:"文档正文"})).toContainText("参考来源");
  for (const format of ["MD", "DOCX", "PDF"]) {
    const response = page.waitForResponse(r => r.url().includes("/download") && r.url().includes(format.toLowerCase()));
    const download = page.waitForEvent("download");
    await page.getByRole("button",{name:`下载 ${format}`,exact:true}).click();
    const res = await response, file = await download, bytes = await fs.readFile((await file.path())!);
    expect(res.ok()).toBeTruthy();
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(res.headers()["x-file-sha256"]);
    if (format === "DOCX") expect(bytes.subarray(0,2).toString()).toBe("PK");
    if (format === "PDF") expect(bytes.subarray(0,5).toString()).toBe("%PDF-");
    if (format === "MD") expect(bytes.toString()).toContain("参考来源");
    await file.saveAs(info.outputPath(`proposal.${format.toLowerCase()}`));
  }
  await page.screenshot({path:info.outputPath("proposal-preview.png"),fullPage:true});
  await expect(page.locator("body")).not.toContainText("PRIVATE_REASONING_FIXTURE");
  const metrics=(await (await request.get("http://127.0.0.1:8738/fixture/metrics")).json()).metrics;
  expect(metrics.filter((m:any)=>m.stage.startsWith("chapter-")).length).toBe(7);
  expect(metrics.filter((m:any)=>m.stage.startsWith("chapter-")).every((m:any)=>m.reasoning === "high" && m.model === "fixture-gemma" && m.identity)).toBeTruthy();
  const task=(await (await request.get(`http://127.0.0.1:8737/v1/tasks/${taskId}`,{headers:{Authorization:`Bearer ${token}`}})).json()).task;
  expect(task.status).toBe("succeeded"); expect(task.modelRuntime.actualModel).toBe("fixture-actual-gemma");
  const head=Buffer.from(JSON.stringify({alg:"HS256"})).toString("base64url"), payload=Buffer.from(JSON.stringify({sub:"22222222-bbbb-4222-8222-222222222222",exp:Math.floor(Date.now()/1000)+300})).toString("base64url");
  const otherToken=head+"."+payload+"."+createHmac("sha256","campusmate-local-e2e-fixture-secret").update(head+"."+payload).digest("base64url");
  const privateFile=await request.get(`http://127.0.0.1:8737/v1/artifacts/${task.result.artifactIds[0]}/download?format=pdf`,{headers:{Authorization:`Bearer ${otherToken}`}});
  expect(privateFile.status()).toBe(404);
});

test("课表预览→确认：Calendar和Today使用同一批课程", async ({page,request},info)=>{
  const token=await login(page), headers={Authorization:`Bearer ${token}`};
  const {today}=await (await request.get("http://127.0.0.1:8738/fixture/metrics")).json();
  const terms=(await (await request.get("http://127.0.0.1:8737/v1/terms",{headers})).json()).terms;
  const weekday=new Date(today+"T12:00:00Z").getUTCDay() || 7;
  await page.goto("/app/calendar");
  await expect(page.locator("body")).not.toContainText("报名开源技术沙龙");
  await page.locator("summary").filter({hasText:"导入课表与设置作息"}).click();
  await page.getByLabel("选择课表文件").setInputFiles({name:"fixture.csv",mimeType:"text/csv",buffer:Buffer.from(`courseName,weekday,startTime,endTime,startWeek,endWeek,weekPattern,classroom,campus\n集成验收课程,${weekday},08:00,09:40,1,24,every,测试楼101,主校区`)});
  await page.getByRole("button",{name:"生成预览",exact:true}).click();
  await expect(page.getByRole("region",{name:"课表导入预览"})).toContainText("预览 1 条有效课程");
  const read=()=>request.get(`http://127.0.0.1:8737/v1/schedules?termId=${terms[0].id}`,{headers}).then(r=>r.json());
  expect((await read()).schedules).toHaveLength(0);
  await page.getByRole("button",{name:"确认添加课表",exact:true}).click();
  await expect(page.getByText("已确认导入 1 条课程")).toBeVisible();
  expect((await read()).schedules).toHaveLength(1);
  await page.getByRole("button",{name:"日",exact:true}).click();
  await expect(page.getByRole("region",{name:"当日安排"})).toContainText("集成验收课程");
  await page.goto("/app"); await expect(page.getByText("集成验收课程",{exact:true}).first()).toBeVisible();
  await page.reload(); await expect(page.getByText("集成验收课程",{exact:true}).first()).toBeVisible();
  await page.screenshot({path:info.outputPath("today-course.png"),fullPage:true});
});

test("取消保留记录；失败后新对话继续，旧任务恢复提示新消息", async ({page,request})=>{
  const token=await login(page), headers={Authorization:`Bearer ${token}`}; await page.goto("/app/agent");
  const cancelled=await send(page,"取消演示：运行一个耗时任务");
  await page.getByRole("button",{name:"取消任务",exact:true}).click();
  const task=(id:string)=>request.get(`http://127.0.0.1:8737/v1/tasks/${id}`,{headers}).then(r=>r.json()).then(r=>r.task);
  await expect.poll(async()=>(await task(cancelled)).status,{timeout:15_000}).toBe("cancelled");
  const failed=await send(page,"故意失败：离线故障用例");
  await expect.poll(async()=>(await task(failed)).status).toBe("failed");
  await send(page,"我是计算机专业大二学生，继续下一轮。");
  await expect(page.getByText("已记录你的计算机专业大二身份和每周8小时约束。",{exact:true})).toBeVisible();
  await page.getByLabel("查看任务记录").selectOption(failed);
  const response=page.waitForResponse(r=>r.url().endsWith(`/${failed}/resume`));
  await page.getByRole("button",{name:"恢复任务",exact:true}).click();
  expect((await response).status()).toBe(409);
  await expect(page.getByRole("alert")).toContainText("后续对话已开始，请用新消息继续");
  expect((await task(failed)).status).toBe("failed");
  await page.reload(); await page.getByLabel("查看任务记录").selectOption(cancelled);
  await expect(page.getByRole("status").filter({hasText:"已取消"})).toBeVisible();
});

test("BYOK设置→测试→默认→真实任务配置与返回模型分开展示",async({page,request})=>{
  const token=await login(page); await page.goto("/app/settings");
  await page.getByRole("button",{name:"模型供应商",exact:true}).click();
  await page.getByLabel("连接 ID",{exact:true}).fill("fixture-byok");
  await page.getByLabel("显示名称",{exact:true}).fill("自定义验收模型");
  await page.getByLabel("API 地址",{exact:true}).fill("https://fixture.example/v1");
  await page.getByLabel("模型 ID",{exact:true}).fill("fixture-custom-model");
  await page.getByLabel("API 密钥",{exact:true}).fill("fixture-only-custom-secret");
  await page.getByRole("button",{name:"添加供应商",exact:true}).click();
  await page.getByRole("button",{name:"测试连接 自定义验收模型",exact:true}).click();
  await expect(page.getByRole("status").filter({hasText:"连接成功"})).toContainText("实际 fixture-actual-gemma");
  await page.getByRole("button",{name:"设为默认 自定义验收模型",exact:true}).click();
  await page.goto("/app/agent");
  await expect(page.getByRole("combobox").filter({hasText:"自定义验收模型"})).toBeVisible();
  const id=await send(page,"我是计算机专业大二学生，测试自定义模型。");
  await expect(page.getByText("最近返回：fixture-actual-gemma")).toBeVisible();
  const task=(await (await request.get(`http://127.0.0.1:8737/v1/tasks/${id}`,{headers:{Authorization:`Bearer ${token}`}})).json()).task;
  expect(task.modelConfig.modelId).toBe("fixture-custom-model");
  const list=await (await request.get("http://127.0.0.1:8737/v1/providers",{headers:{Authorization:`Bearer ${token}`}})).text();
  expect(list).not.toContain("fixture-only-custom-secret"); expect(list).not.toContain("ciphertext");
});

test("样板页面在390/768/1440及明暗主题可用，窄屏预览支持Escape",async({page},info)=>{
  await login(page);
  for(const theme of ["light","dark"]){
    await page.goto("/app/settings");
    await page.getByRole("button",{name:"通用与外观",exact:true}).click();
    await page.getByRole("button",{name:theme === "light" ? "浅色":"深色",exact:true}).click();
    for(const width of [390,768,1440]){
      await page.setViewportSize({width,height:1000});
      for(const route of ["inbox","calendar"]){
        await page.goto(`/app/${route}`);
        await expect(page.locator("html")).toHaveAttribute("data-theme",theme);
        await expect(page.getByRole("heading",{level:1})).toBeVisible();
        expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
        if(route === "inbox"){
          await page.getByRole("searchbox",{name:"搜索通知"}).fill("创新竞赛");
          await page.getByRole("button",{name:/预览离线夹具：校园创新竞赛/}).click();
          if(width < 1024){
            await expect(page.getByRole("dialog",{name:"通知预览"})).toBeVisible();
            await page.getByRole("button",{name:"关闭",exact:true}).press("Escape");
            await expect(page.getByRole("dialog",{name:"通知预览"})).not.toBeVisible();
            await expect(page.getByRole("button",{name:/预览离线夹具：校园创新竞赛/})).toBeFocused();
          } else await expect(page.getByRole("complementary",{name:"通知预览"})).toBeVisible();
        } else await expect(page.getByText("集成验收课程",{exact:true}).first()).toBeVisible();
        await page.screenshot({path:info.outputPath(`${route}-${theme}-${width}.png`),fullPage:true});
      }
    }
  }
});
