import { type ReactNode, useState } from "react";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensors,
  useSensor,
  closestCenter,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  sortableKeyboardCoordinates,
  horizontalListSortingStrategy,
  rectSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVerticalIcon } from "lucide-react";
export function GroupSortArea({
  paths,
  onMove,
  horizontal,
  children,
}: {
  paths: string[];
  onMove: (from: string, to: string) => void;
  horizontal?: boolean;
  children: ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const [active, setActive] = useState<string | null>(null);
  const end = ({ active, over }: DragEndEvent) => {
    setActive(null);
    if (over && active.id !== over.id)
      onMove(String(active.id), String(over.id));
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={(e) => setActive(String(e.active.id))}
      onDragCancel={() => setActive(null)}
      onDragEnd={end}
    >
      <SortableContext
        items={paths}
        strategy={
          horizontal ? horizontalListSortingStrategy : rectSortingStrategy
        }
      >
        {horizontal ? (
          <div
            role="tablist"
            aria-label="Project versions"
            data-group-dragging={active ? "true" : "false"}
            className="flex min-w-0 shrink-0 gap-1 overflow-x-auto border-b px-4 pt-2"
          >
            {children}
          </div>
        ) : (
          <div
            role="group"
            aria-label="Project previews"
            data-group-dragging={active ? "true" : "false"}
            className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-5"
          >
            {children}
          </div>
        )}
      </SortableContext>
    </DndContext>
  );
}
export function SortableGroupMember({
  path,
  label,
  disabled,
  tab,
  children,
}: {
  path: string;
  label: string;
  disabled: boolean;
  tab?: boolean;
  children: ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: path,
    disabled,
    transition: { duration: 200, easing: "cubic-bezier(0.2,0.8,0.2,1)" },
  });
  const { onKeyDown, ...pointerListeners } = listeners || {};
  return (
    <div
      ref={setNodeRef}
      {...pointerListeners}
      data-group-sortable={path}
      className={`relative min-w-0 motion-reduce:transition-none! ${tab ? "shrink-0" : ""} ${isDragging ? "z-40 opacity-80" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <button
        ref={setActivatorNodeRef}
        {...attributes}
        onKeyDown={(event) => onKeyDown?.(event)}
        disabled={disabled}
        type="button"
        aria-label={`Move ${label}`}
        className={`absolute left-1 z-10 flex h-7 w-5 touch-none items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground ${tab ? "top-2" : "top-1"} ${isDragging ? "cursor-grabbing" : "cursor-grab"}`}
      >
        <GripVerticalIcon size={13} />
      </button>
      {children}
    </div>
  );
}
