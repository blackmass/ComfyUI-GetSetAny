class AnyType(str):
    """모든 타입과 연결 가능하게 만드는 와일드카드 타입."""

    def __ne__(self, other):
        return False


ANY = AnyType("*")


class SetAny:
    """값을 키에 등록한다. 실제 연결은 프론트엔드(JS)가 프롬프트 생성 시점에 처리한다."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "key": ("STRING", {"default": ""}),
                "priority": ("INT", {"default": 0, "min": -9999, "max": 9999, "step": 1}),
            },
            "optional": {
                "value": (ANY,),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "run"
    CATEGORY = "utils/GetSetAny"

    def run(self, key, priority, value=None):
        return ()


class GetAny:
    """같은 키의 SetAny 중 우선순위가 가장 높은 값을 꺼낸다."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "key": ("STRING", {"default": ""}),
            },
        }

    RETURN_TYPES = (ANY,)
    RETURN_NAMES = ("value",)
    FUNCTION = "run"
    CATEGORY = "utils/GetSetAny"

    def run(self, key):
        # 정상 동작 시 프론트엔드가 이 노드를 프롬프트에서 제거하므로 여기까지 오지 않는다.
        raise RuntimeError(
            "[GetSetAny] GetAny가 프론트엔드에서 치환되지 않았습니다. "
            "브라우저를 새로고침(Ctrl+F5)했는지, JS 확장이 로드되었는지 확인하세요."
        )


NODE_CLASS_MAPPINGS = {
    "SetAny": SetAny,
    "GetAny": GetAny,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SetAny": "Set Any (GetSetAny)",
    "GetAny": "Get Any (GetSetAny)",
}
