import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { repository } from "@/app/config";
import {
  CategoryBadge,
  ClassBadge,
  DeadlineTag,
  EmptyState,
  PageHeader,
} from "@/components/shared";

export function InboxPage() {
  const { data: items = [], isLoading } = useQuery({
    queryKey: ["inbox"],
    queryFn: () => repository.listInbox(),
  });

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Campus Inbox"
        description="导入校园通知，AI 提取结构化信息并经你确认后保存。"
        actions={
          <Button asChild>
            <Link to="/app/inbox/new"><Plus className="size-4" />导入通知</Link>
          </Button>
        }
      />
      {isLoading ? (
        <p className="text-sm text-muted-foreground">加载中…</p>
      ) : items.length === 0 ? (
        <EmptyState title="收件箱为空" hint="点击「导入通知」粘贴一条校园通知开始。" />
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((item) => (
            <Link key={item.id} to={`/app/inbox/${item.id}`}>
              <Card className="transition-shadow hover:shadow-md">
                <CardContent className="flex flex-col gap-2 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <ClassBadge value={item.classification.class} />
                    <CategoryBadge value={item.extracted.category} />
                    <span className="ml-auto text-xs text-muted-foreground">
                      优先级 {item.classification.priorityScore}
                    </span>
                  </div>
                  <p className="font-medium leading-snug">{item.extracted.title}</p>
                  <div className="flex flex-wrap items-center gap-3">
                    <DeadlineTag deadline={item.extracted.deadline} />
                    {item.extracted.org && (
                      <span className="text-xs text-muted-foreground">{item.extracted.org}</span>
                    )}
                    <span className="ml-auto text-xs text-muted-foreground">{item.status}</span>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}