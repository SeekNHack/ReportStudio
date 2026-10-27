import { useEffect, useRef, useState } from 'preact/hooks';

/** Text input that keeps what the user types while focused and commits after a pause or on blur. */
export function TextInput(props: { value: string; onCommit: (v: string) => void; placeholder?: string; class?: string; mono?: boolean; commitOnBlurOnly?: boolean; disabled?: boolean; multiline?: boolean }) {
  const [local, setLocal] = useState(props.value);
  const focused = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!focused.current) setLocal(props.value);
  }, [props.value]);
  const commit = (v: string) => {
    clearTimeout(timer.current);
    if (v !== props.value) props.onCommit(v);
  };
  const common = {
    class: `input ${props.mono ? 'mono' : ''} ${props.class ?? ''}`,
    value: local,
    placeholder: props.placeholder,
    disabled: props.disabled,
    onFocus: () => (focused.current = true),
    onBlur: () => {
      focused.current = false;
      commit(local);
    },
    onInput: (e: Event) => {
      const v = (e.target as HTMLInputElement).value;
      setLocal(v);
      if (!props.commitOnBlurOnly) {
        clearTimeout(timer.current);
        timer.current = window.setTimeout(() => commit(v), 450);
      }
    },
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !props.multiline) (e.target as HTMLInputElement).blur();
    },
  };
  return props.multiline ? <textarea rows={3} {...common} /> : <input {...common} />;
}

export function Toggle(props: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button class={`toggle ${props.on ? 'on' : ''}`} disabled={props.disabled} onClick={() => props.onChange(!props.on)}>
      <span class="toggle-knob" />
      <span class="toggle-text">{props.label ?? (props.on ? 'Yes' : 'No')}</span>
    </button>
  );
}

export function Prop(props: { label: string; help?: string; children: preact.ComponentChildren; wide?: boolean }) {
  return (
    <div class={`prop ${props.wide ? 'wide' : ''}`}>
      <label>{props.label}</label>
      {props.children}
      {props.help && <div class="field-help">{props.help}</div>}
    </div>
  );
}

/* ------------------------------------------------------------ options */

