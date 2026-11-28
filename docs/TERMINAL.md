# 终端

## 入口

主页功能卡“终端”，或设置 → Python → 终端。

## shell

支持：

```sh
ls
cd
pwd
cat
mkdir
rm
cp
mv
echo
```

工作目录在 App 私有目录内。

## Python

```sh
python
```

进入 `>>>`，`exit()` 或 Ctrl+D 返回 shell。

## JS

```sh
js
```

进入 JS 交互模式，`exit()` 返回。

## 快捷命令

```sh
rou py print(1)
rou js 'print(1)'
```

`rou` 会按语言执行一行代码。

## 按键

- Ctrl：Ctrl+C / Ctrl+D / Ctrl+L
- Shift
- Alt
- Tab
- Esc
- 方向键
- Home / End
- F1–F12：
  - F1 帮助
  - F2 清屏
  - F3 历史
  - F4 文件
  - F5 刷新
  - F6 Python
  - F7 JS
  - F8 Caps
  - F9 更新
  - F10 帮助

F 键是 App 动作，不是把原始转义序列送进 PTY。

## 文件面板

- 浏览目录
- 新建/重命名/删除
- 查看文件
- 与脚本目录互通

## 限制

- 没有持久 PTY；
- 不支持交互式全屏程序；
- `pip` 走模块商店的运行时，不是系统 Python。
