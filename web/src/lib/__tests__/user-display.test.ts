import { describe, expect, it } from "vitest";
import { parsePlatformProfile } from "../user-display";

describe("Qoder 平台资料解析", () => {
  it("解析昵称与头像，并兼容嵌套 user/profile", () => {
    expect(parsePlatformProfile({ user: { display_name: "小 Q", avatar_url: "https://cdn.example/a.png" } }))
      .toEqual({ name: "小 Q", avatarUrl: "https://cdn.example/a.png" });
    expect(parsePlatformProfile({ profile: { nickname: "Campus", picture: "https://cdn.example/b.png" } }))
      .toEqual({ name: "Campus", avatarUrl: "https://cdn.example/b.png" });
  });

  it("缺少昵称时使用邮箱前缀，不返回空字符串", () => {
    expect(parsePlatformProfile({ email: "student@example.com" })).toEqual({ name: "student", avatarUrl: "" });
    expect(parsePlatformProfile(null)).toEqual({ name: "", avatarUrl: "" });
  });
});
