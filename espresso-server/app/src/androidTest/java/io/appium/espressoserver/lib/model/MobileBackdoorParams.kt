package io.appium.espressoserver.lib.model

import com.google.gson.annotations.SerializedName

@SuppressWarnings("unused")
data class MobileBackdoorParams(
        val target: InvocationTarget? = null,
        val elementId: String? = null,
        val methods: List<MobileBackdoorMethod>? = null
) : AppiumParams() {

    enum class InvocationTarget {
        @SerializedName("activity")
        ACTIVITY,
        @SerializedName("application")
        APPLICATION,
        @SerializedName("element")
        ELEMENT
    }

}

