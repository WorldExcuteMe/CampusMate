import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useRepository } from "@/app/auth";
import { PageHeader } from "@/components/shared";

const formSchema = z.object({
  name: z.string().min(1),
  major: z.string().min(1),
  grade: z.string().min(1),
  interests: z.string(),
  skills: z.string(),
  goals: z.string(),
  timeBudgetHours: z.coerce.number().min(0).max(80),
  bio: z.string(),
});
type FormValues = z.infer<typeof formSchema>;

const split = (s: string) => s.split(/[,，、\n]/).map((x) => x.trim()).filter(Boolean);

export function ProfilePage() {
  const repository = useRepository();
  const qc = useQueryClient();
  const { data: profile } = useQuery({ queryKey: ["profile"], queryFn: () => repository.getProfile() });
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "", major: "", grade: "", interests: "", skills: "", goals: "", timeBudgetHours: 10, bio: "",
    },
  });

  useEffect(() => {
    if (profile) {
      form.reset({
        name: profile.name,
        major: profile.major,
        grade: profile.grade,
        interests: profile.interests.join("、"),
        skills: profile.skills.join("、"),
        goals: profile.goals.join("、"),
        timeBudgetHours: profile.timeBudgetHours,
        bio: profile.bio,
      });
    }
  }, [profile, form]);

  const save = useMutation({
    mutationFn: (v: FormValues) =>
      repository.updateProfile({
        id: profile?.id ?? "demo-user",
        name: v.name,
        major: v.major,
        grade: v.grade,
        interests: split(v.interests),
        skills: split(v.skills),
        goals: split(v.goals),
        timeBudgetHours: v.timeBudgetHours,
        bio: v.bio,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["profile"] });
      toast.success("画像已保存");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "保存失败"),
  });

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="个人画像" description="用于机会匹配与任务规划；匹配权重可在设置中调整。" />
      <Card>
        <CardHeader><CardTitle className="text-base">基本信息</CardTitle></CardHeader>
        <CardContent>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={form.handleSubmit((v) => save.mutate(v))}>
            <div><Label>姓名</Label><Input {...form.register("name")} /></div>
            <div><Label>专业</Label><Input {...form.register("major")} /></div>
            <div><Label>年级</Label><Input {...form.register("grade")} /></div>
            <div><Label>每周时间预算（小时）</Label><Input type="number" {...form.register("timeBudgetHours")} /></div>
            <div className="sm:col-span-2"><Label>兴趣（顿号分隔）</Label><Input {...form.register("interests")} /></div>
            <div className="sm:col-span-2"><Label>技能（顿号分隔）</Label><Input {...form.register("skills")} /></div>
            <div className="sm:col-span-2"><Label>发展目标（顿号分隔）</Label><Input {...form.register("goals")} /></div>
            <div className="sm:col-span-2"><Label>简介</Label><Textarea rows={2} {...form.register("bio")} /></div>
            <div className="sm:col-span-2">
              <Button type="submit" disabled={save.isPending}>保存画像</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}