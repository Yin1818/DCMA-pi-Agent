import { Paperclip, Send, Square } from "lucide-react";
import { type KeyboardEvent, useLayoutEffect, useRef, useState } from "react";
import { defaultWebKeybindings } from "../keyboard.ts";
export function ChatInput({
	onSendMessage,
	disabled,
	onStop,
	onImport,
}: {
	onSendMessage: (text: string) => void;
	disabled: boolean;
	onStop: () => void;
	onImport: () => void;
}) {
	const [value, setValue] = useState("");
	const textarea = useRef<HTMLTextAreaElement>(null);
	const composing = useRef(false);
	useLayoutEffect(() => {
		const input = textarea.current;
		if (!input) return;
		input.style.height = "28px";
		if (value) input.style.height = `${Math.min(input.scrollHeight, 128)}px`;
	}, [value]);
	const send = () => {
		if (!value.trim() || disabled) return;
		onSendMessage(value.trim());
		setValue("");
	};
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (
			event.key === defaultWebKeybindings.submit &&
			!event.shiftKey &&
			!event.nativeEvent.isComposing &&
			!composing.current
		) {
			event.preventDefault();
			send();
		}
	};
	return (
		<div className="shrink-0 px-3 sm:px-6 pb-4 pt-2">
			<div className="relative max-w-[800px] mx-auto">
				<div className="bg-white border border-slate-200 rounded-2xl p-2 flex gap-1 items-end shadow-sm focus-within:border-blue-400">
					<button
						type="button"
						onClick={onImport}
						aria-label="上传遥测日志或设备档案 (CSV/LOG)"
						className="shrink-0 p-2 text-slate-500 hover:bg-blue-50 rounded-xl"
					>
						<Paperclip className="w-4 h-4" />
					</button>
					<textarea
						ref={textarea}
						aria-label="问题输入"
						value={value}
						maxLength={8000}
						onChange={(event) => setValue(event.target.value)}
						onKeyDown={onKeyDown}
						onCompositionStart={() => {
							composing.current = true;
						}}
						onCompositionEnd={() => {
							composing.current = false;
						}}
						disabled={disabled}
						placeholder="输入问题，Enter 发送，Shift+Enter 换行…"
						rows={1}
						className="min-w-0 flex-1 bg-transparent outline-none text-sm resize-none px-2 py-1 max-h-32 disabled:opacity-50"
					/>
					{disabled ? (
						<button
							type="button"
							aria-label="停止生成"
							onClick={onStop}
							className="p-2 bg-red-50 text-red-600 rounded-xl"
						>
							<Square className="w-4 h-4" />
						</button>
					) : (
						<button
							type="button"
							aria-label="发送问题"
							disabled={!value.trim()}
							onClick={send}
							className="p-2 bg-blue-600 text-white rounded-xl disabled:opacity-40"
						>
							<Send className="w-4 h-4" />
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
